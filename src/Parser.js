// @flow
/* eslint no-constant-condition:0 */
import functions from "./functions";
import MacroExpander, {implicitCommands} from "./MacroExpander";
import symbols, {ATOMS, extraLatin} from "./symbols";
import {validUnit} from "./units";
import {supportedCodepoint} from "./unicodeScripts";
import unicodeAccents from "./unicodeAccents";
import unicodeSymbols from "./unicodeSymbols";
import ParseError from "./ParseError";
import {combiningDiacriticalMarksEndRegex} from "./Lexer";
import Settings from "./Settings";
import SourceLocation from "./SourceLocation";
import {Token} from "./Token";
import type {ParseNode, AnyParseNode, SymbolParseNode, UnsupportedCmdParseNode}
    from "./parseNode";
import type {Atom, Group} from "./symbols";
import type {Mode, ArgType, BreakToken} from "./types";
import type {FunctionContext, FunctionSpec} from "./defineFunction";
import type {EnvSpec} from "./defineEnvironment";

/**
 * This file contains the parser used to parse out a TeX expression from the
 * input. Since TeX isn't context-free, standard parsers don't work particularly
 * well.
 *
 * The strategy of this parser is as such:
 *
 * The main functions (the `.parse...` ones) take a position in the current
 * parse string to parse tokens from. The lexer (found in Lexer.js, stored at
 * this.gullet.lexer) also supports pulling out tokens at arbitrary places. When
 * individual tokens are needed at a position, the lexer is called to pull out a
 * token, which is then used.
 *
 * The parser has a property called "mode" indicating the mode that
 * the parser is currently in. Currently it has to be one of "math" or
 * "text", which denotes whether the current environment is a math-y
 * one or a text-y one (e.g. inside \text). Currently, this serves to
 * limit the functions which can be used in text mode.
 *
 * The main functions then return an object which contains the useful data that
 * was parsed at its given point, and a new position at the end of the parsed
 * data. The main functions can call each other and continue the parsing by
 * using the returned position as a new starting point.
 *
 * There are also extra `.handle...` functions, which pull out some reused
 * functionality into self-contained functions.
 *
 * The functions return ParseNodes.
 */

export default class Parser {
    mode: Mode;
    gullet: MacroExpander;
    settings: Settings;
    leftrightDepth: number;
    nextToken: ?Token;

    constructor(input: string, settings: Settings) {
        // Start in math mode
        this.mode = "math";
        // Create a new macro expander (gullet) and (indirectly via that) also a
        // new lexer (mouth) for this parser (stomach, in the language of TeX)
        this.gullet = new MacroExpander(input, settings, this.mode);
        // Store the settings for use in parsing
        this.settings = settings;
        // Count leftright depth (for \middle errors)
        this.leftrightDepth = 0;
    }

    /**
     * Checks a result to make sure it has the right type, and throws an
     * appropriate error otherwise.
     */
    expect(text: string, consume?: boolean = true) {
        if (this.fetch().text !== text) {
            throw new ParseError(
                `Expected '${text}', got '${this.fetch().text}'`, this.fetch()
            );
        }
        if (consume) {
            this.consume();
        }
    }

    /**
     * Discards the current lookahead token, considering it consumed.
     */
    consume() {
        this.nextToken = null;
    }

    /**
     * Return the current lookahead token, or if there isn't one (at the
     * beginning, or if the previous lookahead token was consume()d),
     * fetch the next token as the new lookahead token and return it.
     */
    fetch(): Token {
        if (this.nextToken == null) {
            this.nextToken = this.gullet.expandNextToken();
        }
        return this.nextToken;
    }

    /**
     * Switches between "text" and "math" modes.
     */
    switchMode(newMode: Mode) {
        this.mode = newMode;
        this.gullet.switchMode(newMode);
    }

    /**
     * Main parsing function, which parses an entire input.
     */
    parse(): AnyParseNode[] {
        if (!this.settings.globalGroup) {
            // Create a group namespace for the math expression.
            // (LaTeX creates a new group for every $...$, $$...$$, \[...\].)
            this.gullet.beginGroup();
        }

        // Use old \color behavior (same as LaTeX's \textcolor) if requested.
        // We do this within the group for the math expression, so it doesn't
        // pollute settings.macros.
        if (this.settings.colorIsTextColor) {
            this.gullet.macros.set("\\color", "\\textcolor");
        }

        // Try to parse the input
        const parse = this.parseExpression(false);

        // If we succeeded, make sure there's an EOF at the end
        this.expect("EOF");

        // End the group namespace for the expression
        if (!this.settings.globalGroup) {
            this.gullet.endGroup();
        }
        return parse;
    }

    static endOfExpression = ["}", "\\endgroup", "\\end", "\\right", "&"];

    static endOfGroup = {
        "[": "]",
        "{": "}",
        "\\begingroup": "\\endgroup",
    }

    /**
     * Parses an "expression", which is a list of atoms.
     *
     * `breakOnInfix`: Should the parsing stop when we hit infix nodes? This
     *                 happens when functions have higher precendence han infix
     *                 nodes in implicit parses.
     *
     * `breakOnTokenText`: The text of the token that the expression should end
     *                     with, or `null` if something else should end the
     *                     expression.
     */
    parseExpression(
        breakOnInfix: boolean,
        breakOnTokenText?: BreakToken,
    ): AnyParseNode[] {
        const body = [];
        // Keep adding atoms to the body until we can't parse any more atoms (either
        // we reached the end, a }, or a \right)
        while (true) {
            // Ignore spaces in math mode
            if (this.mode === "math") {
                this.consumeSpaces();
            }
            const lex = this.fetch();
            if (Parser.endOfExpression.indexOf(lex.text) !== -1) {
                break;
            }
            if (breakOnTokenText && lex.text === breakOnTokenText) {
                break;
            }
            if (breakOnInfix && functions[lex.text] && functions[lex.text].infix) {
                break;
            }
            const atom = this.parseAtom(breakOnTokenText);
            if (!atom) {
                break;
            }
            body.push(atom);
        }
        if (this.mode === "text") {
            this.formLigatures(body);
        }
        return this.handleInfixNodes(body);
    }

    /**
     * Rewrites infix operators such as \over with corresponding commands such
     * as \frac.
     *
     * There can only be one infix operator per group.  If there's more than one
     * then the expression is ambiguous.  This can be resolved by adding {}.
     */
    handleInfixNodes(body: AnyParseNode[]): AnyParseNode[] {
        let overIndex = -1;
        let funcName;

        for (let i = 0; i < body.length; i++) {
            if (body[i].type === "infix") {
                if (overIndex !== -1) {
                    throw new ParseError(
                        "only one infix operator per group",
                        body[i].token);
                }
                overIndex = i;
                funcName = body[i].replaceWith;
            }
        }

        if (overIndex !== -1 && funcName) {
            let numerNode;
            let denomNode;

            const numerBody = body.slice(0, overIndex);
            const denomBody = body.slice(overIndex + 1);

            if (numerBody.length === 1 && numerBody[0].type === "ordgroup") {
                numerNode = numerBody[0];
            } else {
                numerNode = {type: "ordgroup", mode: this.mode, body: numerBody};
            }

            if (denomBody.length === 1 && denomBody[0].type === "ordgroup") {
                denomNode = denomBody[0];
            } else {
                denomNode = {type: "ordgroup", mode: this.mode, body: denomBody};
            }

            let node;
            if (funcName === "\\\\abovefrac") {
                node = this.callFunction(funcName,
                    [numerNode, body[overIndex], denomNode], []);
            } else {
                node = this.callFunction(funcName, [numerNode, denomNode], []);
            }
            return [node];
        } else {
            return body;
        }
    }

    // The greediness of a superscript or subscript
    static SUPSUB_GREEDINESS = 1;

    /**
     * Handle a subscript or superscript with nice errors.
     */
    handleSupSubscript(
        name: string,   // For error reporting.
    ): AnyParseNode {
        const symbolToken = this.fetch();
        const symbol = symbolToken.text;
        this.consume();
        const group = this.parseGroup(name, false, Parser.SUPSUB_GREEDINESS,
            undefined, undefined, true);
                                 // ignore spaces before sup/subscript argument

        if (!group) {
            throw new ParseError(
                "Expected group after '" + symbol + "'",
                symbolToken
            );
        }

        return group;
    }

    /**
     * Converts the textual input of an unsupported command into a text node
     * contained within a color node whose color is determined by errorColor
     */
    formatUnsupportedCmd(text: string): UnsupportedCmdParseNode {
        const textordArray = [];

        for (let i = 0; i < text.length; i++) {
            textordArray.push({type: "textord", mode: "text", text: text[i]});
        }

        const textNode = {
            type: "text",
            mode: this.mode,
            body: textordArray,
        };

        const colorNode = {
            type: "color",
            mode: this.mode,
            color: this.settings.errorColor,
            body: [textNode],
        };

        return colorNode;
    }

    /**
     * Parses a group with optional super/subscripts.
     */
    parseAtom(breakOnTokenText?: BreakToken): ?AnyParseNode {
        // The body of an atom is an implicit group, so that things like
        // \left(x\right)^2 work correctly.
        const base = this.parseGroup("atom", false, null, breakOnTokenText);

        // In text mode, we don't have superscripts or subscripts
        if (this.mode === "text") {
            return base;
        }

        // Note that base may be empty (i.e. null) at this point.

        let superscript;
        let subscript;
        while (true) {
            // Guaranteed in math mode, so eat any spaces first.
            this.consumeSpaces();

            // Lex the first token
            const lex = this.fetch();

            if (lex.text === "\\limits" || lex.text === "\\nolimits") {
                // We got a limit control
                if (base && base.type === "op") {
                    const limits = lex.text === "\\limits";
                    base.limits = limits;
                    base.alwaysHandleSupSub = true;
                } else if (base && base.type === "operatorname"
                        && base.alwaysHandleSupSub) {
                    const limits = lex.text === "\\limits";
                    base.limits = limits;
                } else {
                    throw new ParseError(
                        "Limit controls must follow a math operator",
                        lex);
                }
                this.consume();
            } else if (lex.text === "^") {
                // We got a superscript start
                if (superscript) {
                    throw new ParseError("Double superscript", lex);
                }
                superscript = this.handleSupSubscript("superscript");
            } else if (lex.text === "_") {
                // We got a subscript start
                if (subscript) {
                    throw new ParseError("Double subscript", lex);
                }
                subscript = this.handleSupSubscript("subscript");
            } else if (lex.text === "'") {
                // We got a prime
                if (superscript) {
                    throw new ParseError("Double superscript", lex);
                }
                const prime = {type: "textord", mode: this.mode, text: "\\prime"};

                // Many primes can be grouped together, so we handle this here
                const primes = [prime];
                this.consume();
                // Keep lexing tokens until we get something that's not a prime
                while (this.fetch().text === "'") {
                    // For each one, add another prime to the list
                    primes.push(prime);
                    this.consume();
                }
                // If there's a superscript following the primes, combine that
                // superscript in with the primes.
                if (this.fetch().text === "^") {
                    primes.push(this.handleSupSubscript("superscript"));
                }
                // Put everything into an ordgroup as the superscript
                superscript = {type: "ordgroup", mode: this.mode, body: primes};
            } else {
                // If it wasn't ^, _, or ', stop parsing super/subscripts
                break;
            }
        }

        // Base must be set if superscript or subscript are set per logic above,
        // but need to check here for type check to pass.
        if (superscript || subscript) {
            // If we got either a superscript or subscript, create a supsub
            return {
                type: "supsub",
                mode: this.mode,
                base: base,
                sup: superscript,
                sub: subscript,
            };
        } else {
            // Otherwise return the original body
            return base;
        }
    }

    /**
     * Parses an entire function, including its base and all of its arguments.
     */
    parseFunction(
        breakOnTokenText?: BreakToken,
        name?: string, // For error reporting.
        greediness?: ?number,
    ): ?AnyParseNode {
        const token = this.fetch();
        const func = token.text;
        const funcData = functions[func];
        if (!funcData) {
            return null;
        }
        this.consume(); // consume command token

        if (greediness != null && funcData.greediness <= greediness) {
            throw new ParseError(
                "Got function '" + func + "' with no arguments" +
                (name ? " as " + name : ""), token);
        } else if (this.mode === "text" && !funcData.allowedInText) {
            throw new ParseError(
                "Can't use function '" + func + "' in text mode", token);
        } else if (this.mode === "math" && funcData.allowedInMath === false) {
            throw new ParseError(
                "Can't use function '" + func + "' in math mode", token);
        }

        const {args, optArgs} = this.parseArguments(func, funcData);
        return this.callFunction(func, args, optArgs, token, breakOnTokenText);
    }

    /**
     * Call a function handler with a suitable context and arguments.
     */
    callFunction(
        name: string,
        args: AnyParseNode[],
        optArgs: (?AnyParseNode)[],
        token?: Token,
        breakOnTokenText?: BreakToken,
    ): AnyParseNode {
        const context: FunctionContext = {
            funcName: name,
            parser: this,
            token,
            breakOnTokenText,
        };
        const func = functions[name];
        if (func && func.handler) {
            return func.handler(context, args, optArgs);
        } else {
            throw new ParseError(`No function handler for ${name}`);
        }
    }

    /**
     * Parses the arguments of a function or environment
     */
    parseArguments(
        func: string,   // Should look like "\name" or "\begin{name}".
        funcData: FunctionSpec<*> | EnvSpec<*>,
    ): {
        args: AnyParseNode[],
        optArgs: (?AnyParseNode)[],
    } {
        const totalArgs = funcData.numArgs + funcData.numOptionalArgs;
        if (totalArgs === 0) {
            return {args: [], optArgs: []};
        }

        const baseGreediness = funcData.greediness;
        const args = [];
        const optArgs = [];

        for (let i = 0; i < totalArgs; i++) {
            const argType = funcData.argTypes && funcData.argTypes[i];
            const isOptional = i < funcData.numOptionalArgs;
            // Ignore spaces between arguments.  As the TeXbook says:
            // "After you have said ‘\def\row#1#2{...}’, you are allowed to
            //  put spaces between the arguments (e.g., ‘\row x n’), because
            //  TeX doesn’t use single spaces as undelimited arguments."
            const consumeSpaces = (i > 0 && !isOptional) ||
            // Also consume leading spaces in math mode, as parseSymbol
            // won't know what to do with them.  This can only happen with
            // macros, e.g. \frac\foo\foo where \foo expands to a space symbol.
            // In LaTeX, the \foo's get treated as (blank) arguments.
            // In KaTeX, for now, both spaces will get consumed.
            // TODO(edemaine)
                (i === 0 && !isOptional && this.mode === "math");
            const arg = this.parseGroupOfType(`argument to '${func}'`,
                argType, isOptional, baseGreediness, consumeSpaces);
            if (!arg) {
                if (isOptional) {
                    optArgs.push(null);
                    continue;
                }
                throw new ParseError(
                    `Expected group after '${func}'`, this.fetch());
            }
            (isOptional ? optArgs : args).push(arg);
        }

        return {args, optArgs};
    }

    /**
     * Parses a group when the mode is changing.
     */
    parseGroupOfType(
        name: string,
        type: ?ArgType,
        optional: boolean,
        greediness: ?number,
        consumeSpaces: boolean,
    ): ?AnyParseNode {
        switch (type) {
            case "color":
                if (consumeSpaces) {
                    this.consumeSpaces();
                }
                return this.parseColorGroup(optional);
            case "size":
                if (consumeSpaces) {
                    this.consumeSpaces();
                }
                return this.parseSizeGroup(optional);
            case "url":
                return this.parseUrlGroup(optional, consumeSpaces);
            case "math":
            case "text":
                return this.parseGroup(
                    name, optional, greediness, undefined, type, consumeSpaces);
            case "hbox": {
                // hbox argument type wraps the argument in the equivalent of
                // \hbox, which is like \text but switching to \textstyle size.
                const group = this.parseGroup(name, optional, greediness,
                    undefined, "text", consumeSpaces);
                if (!group) {
                    return group;
                }
                const styledGroup = {
                    type: "styling",
                    mode: group.mode,
                    body: [group],
                    style: "text", // simulate \textstyle
                };
                return styledGroup;
            }
            case "raw": {
                if (consumeSpaces) {
                    this.consumeSpaces();
                }
                if (optional && this.fetch().text === "{") {
                    return null;
                }
                const token = this.parseStringGroup("raw", optional, true);
                if (token) {
                    return {
                        type: "raw",
                        mode: "text",
                        string: token.text,
                    };
                } else {
                    throw new ParseError("Expected raw group", this.fetch());
                }
            }
            case "original":
            case null:
            case undefined:
                return this.parseGroup(name, optional, greediness,
                    undefined, undefined, consumeSpaces);
            default:
                throw new ParseError(
                    "Unknown group type as " + name, this.fetch());
        }
    }

    /**
     * Discard any space tokens, fetching the next non-space token.
     */
    consumeSpaces() {
        while (this.fetch().text === " ") {
            this.consume();
        }
    }

    /**
     * Parses a group, essentially returning the string formed by the
     * brace-enclosed tokens plus some position information.
     */
    parseStringGroup(
        modeName: ArgType,  // Used to describe the mode in error messages.
        optional: boolean,
        raw?: boolean,
    ): ?Token {
        const groupBegin = optional ? "[" : "{";
        const groupEnd = optional ? "]" : "}";
        const beginToken = this.fetch();
        if (beginToken.text !== groupBegin) {
            if (optional) {
                return null;
            } else if (raw && beginToken.text !== "EOF" &&
                    /[^{}[\]]/.test(beginToken.text)) {
                this.consume();
                return beginToken;
            }
        }
        const outerMode = this.mode;
        this.mode = "text";
        this.expect(groupBegin);
        let str = "";
        const firstToken = this.fetch();
        let nested = 0; // allow nested braces in raw string group
        let lastToken = firstToken;
        let nextToken;
        while ((nextToken = this.fetch()).text !== groupEnd ||
               (raw && nested > 0)) {
            switch (nextToken.text) {
                case "EOF":
                    throw new ParseError(
                        "Unexpected end of input in " + modeName,
                        firstToken.range(lastToken, str));
                case groupBegin:
                    nested++;
                    break;
                case groupEnd:
                    nested--;
                    break;
            }
            lastToken = nextToken;
            str += lastToken.text;
            this.consume();
        }
        this.expect(groupEnd);
        this.mode = outerMode;
        return firstToken.range(lastToken, str);
    }

    /**
     * Parses a regex-delimited group: the largest sequence of tokens
     * whose concatenated strings match `regex`. Returns the string
     * formed by the tokens plus some position information.
     */
    parseRegexGroup(
        regex: RegExp,
        modeName: string,   // Used to describe the mode in error messages.
    ): Token {
        const outerMode = this.mode;
        this.mode = "text";
        const firstToken = this.fetch();
        let lastToken = firstToken;
        let str = "";
        let nextToken;
        while ((nextToken = this.fetch()).text !== "EOF" &&
               regex.test(str + nextToken.text)) {
            lastToken = nextToken;
            str += lastToken.text;
            this.consume();
        }
        if (str === "") {
            throw new ParseError(
                "Invalid " + modeName + ": '" + firstToken.text + "'",
                firstToken);
        }
        this.mode = outerMode;
        return firstToken.range(lastToken, str);
    }

    /**
     * Parses a color description.
     */
    parseColorGroup(optional: boolean): ?ParseNode<"color-token"> {
        const res = this.parseStringGroup("color", optional);
        if (!res) {
            return null;
        }
        const match = (/^(#[a-f0-9]{3}|#?[a-f0-9]{6}|[a-z]+)$/i).exec(res.text);
        if (!match) {
            throw new ParseError("Invalid color: '" + res.text + "'", res);
        }
        let color = match[0];
        if (/^[0-9a-f]{6}$/i.test(color)) {
            // We allow a 6-digit HTML color spec without a leading "#".
            // This follows the xcolor package's HTML color model.
            // Predefined color names are all missed by this RegEx pattern.
            color = "#" + color;
        }
        return {
            type: "color-token",
            mode: this.mode,
            color,
        };
    }

    /**
     * Parses a size specification, consisting of magnitude and unit.
     */
    parseSizeGroup(optional: boolean): ?ParseNode<"size"> {
        let res;
        let isBlank = false;
        if (!optional && this.fetch().text !== "{") {
            res = this.parseRegexGroup(
                /^[-+]? *(?:$|\d+|\d+\.\d*|\.\d*) *[a-z]{0,2} *$/, "size");
        } else {
            res = this.parseStringGroup("size", optional);
        }
        if (!res) {
            return null;
        }
        if (!optional && res.text.length === 0) {
            // Because we've tested for what is !optional, this block won't
            // affect \kern, \hspace, etc. It will capture the mandatory arguments
            // to \genfrac and \above.
            res.text = "0pt";    // Enable \above{}
            isBlank = true;      // This is here specifically for \genfrac
        }
        const match = (/([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/).exec(res.text);
        if (!match) {
            throw new ParseError("Invalid size: '" + res.text + "'", res);
        }
        const data = {
            number: +(match[1] + match[2]), // sign + magnitude, cast to number
            unit: match[3],
        };
        if (!validUnit(data)) {
            throw new ParseError("Invalid unit: '" + data.unit + "'", res);
        }
        return {
            type: "size",
            mode: this.mode,
            value: data,
            isBlank,
        };
    }

    /**
     * Parses an URL, checking escaped letters and allowed protocols,
     * and setting the catcode of % as an active character (as in \hyperref).
     */
    parseUrlGroup(optional: boolean, consumeSpaces: boolean): ?ParseNode<"url"> {
        this.gullet.lexer.setCatcode("%", 13); // active character
        const res = this.parseStringGroup("url", optional, true); // get raw string
        this.gullet.lexer.setCatcode("%", 14); // comment character
        if (!res) {
            return null;
        }
        // hyperref package allows backslashes alone in href, but doesn't
        // generate valid links in such cases; we interpret this as
        // "undefined" behaviour, and keep them as-is. Some browser will
        // replace backslashes with forward slashes.
        const url = res.text.replace(/\\([#$%&~_^{}])/g, '$1');
        return {
            type: "url",
            mode: this.mode,
            url,
        };
    }

    /**
     * If `optional` is false or absent, this parses an ordinary group,
     * which is either a single nucleus (like "x") or an expression
     * in braces (like "{x+y}") or an implicit group, a group that starts
     * at the current position, and ends right before a higher explicit
     * group ends, or at EOF.
     * If `optional` is true, it parses either a bracket-delimited expression
     * (like "[x+y]") or returns null to indicate the absence of a
     * bracket-enclosed group.
     * If `mode` is present, switches to that mode while parsing the group,
     * and switches back after.
     */
    parseGroup(
        name: string, // For error reporting.
        optional?: boolean,
        greediness?: ?number,
        breakOnTokenText?: BreakToken,
        mode?: Mode,
        consumeSpaces?: boolean,
    ): ?AnyParseNode {
        // Switch to specified mode
        const outerMode = this.mode;
        if (mode) {
            this.switchMode(mode);
        }
        // Consume spaces if requested, crucially *after* we switch modes,
        // so that the next non-space token is parsed in the correct mode.
        if (consumeSpaces) {
            this.consumeSpaces();
        }
        // Get first token
        const firstToken = this.fetch();
        const text = firstToken.text;

        let result;
        // Try to parse an open brace or \begingroup
        if (optional ? text === "["  : text === "{" || text === "\\begingroup") {
            this.consume();
            const groupEnd = Parser.endOfGroup[text];
            // Start a new group namespace
            this.gullet.beginGroup();
            // If we get a brace, parse an expression
            const expression = this.parseExpression(false, groupEnd);
            const lastToken = this.fetch();
            // Check that we got a matching closing brace
            this.expect(groupEnd);
            // End group namespace
            this.gullet.endGroup();
            result = {
                type: "ordgroup",
                mode: this.mode,
                loc: SourceLocation.range(firstToken, lastToken),
                body: expression,
                // A group formed by \begingroup...\endgroup is a semi-simple group
                // which doesn't affect spacing in math mode, i.e., is transparent.
                // https://tex.stackexchange.com/questions/1930/when-should-one-
                // use-begingroup-instead-of-bgroup
                semisimple: text === "\\begingroup" || undefined,
            };
        } else if (optional) {
            // Return nothing for an optional group
            result = null;
        } else {
            // If there exists a function with this name, parse the function.
            // Otherwise, just return a nucleus
            result = this.parseFunction(breakOnTokenText, name, greediness) ||
                this.parseSymbol();
            if (result == null && text[0] === "\\" &&
                    !implicitCommands.hasOwnProperty(text)) {
                if (this.settings.throwOnError) {
                    throw new ParseError(
                        "Undefined control sequence: " + text, firstToken);
                }
                result = this.formatUnsupportedCmd(text);
                this.consume();
            }
        }

        // Switch mode back
        if (mode) {
            this.switchMode(outerMode);
        }
        return result;
    }

    /**
     * Form ligature-like combinations of characters for text mode.
     * This includes inputs like "--", "---", "``" and "''".
     * The result will simply replace multiple textord nodes with a single
     * character in each value by a single textord node having multiple
     * characters in its value.  The representation is still ASCII source.
     * The group will be modified in place.
     */
    formLigatures(group: AnyParseNode[]) {
        let n = group.length - 1;
        for (let i = 0; i < n; ++i) {
            const a = group[i];
            // $FlowFixMe: Not every node type has a `text` property.
            const v = a.text;
            if (v === "-" && group[i + 1].text === "-") {
                if (i + 1 < n && group[i + 2].text === "-") {
                    group.splice(i, 3, {
                        type: "textord",
                        mode: "text",
                        loc: SourceLocation.range(a, group[i + 2]),
                        text: "---",
                    });
                    n -= 2;
                } else {
                    group.splice(i, 2, {
                        type: "textord",
                        mode: "text",
                        loc: SourceLocation.range(a, group[i + 1]),
                        text: "--",
                    });
                    n -= 1;
                }
            }
            if ((v === "'" || v === "`") && group[i + 1].text === v) {
                group.splice(i, 2, {
                    type: "textord",
                    mode: "text",
                    loc: SourceLocation.range(a, group[i + 1]),
                    text: v + v,
                });
                n -= 1;
            }
        }
    }

    /**
     * Parse a single symbol out of the string. Here, we handle single character
     * symbols and special functions like \verb.
     */
    parseSymbol(): ?AnyParseNode {
        const nucleus = this.fetch();
        let text = nucleus.text;

        if (/^\\verb[^a-zA-Z]/.test(text)) {
            this.consume();
            let arg = text.slice(5);
            const star = (arg.charAt(0) === "*");
            if (star) {
                arg = arg.slice(1);
            }
            // Lexer's tokenRegex is constructed to always have matching
            // first/last characters.
            if (arg.length < 2 || arg.charAt(0) !== arg.slice(-1)) {
                throw new ParseError(`\\verb assertion failed --
                    please report what input caused this bug`);
            }
            arg = arg.slice(1, -1);  // remove first and last char
            return {
                type: "verb",
                mode: "text",
                body: arg,
                star,
            };
        }
        // At this point, we should have a symbol, possibly with accents.
        // First expand any accented base symbol according to unicodeSymbols.
        if (unicodeSymbols.hasOwnProperty(text[0]) &&
            !symbols[this.mode][text[0]]) {
            // This behavior is not strict (XeTeX-compatible) in math mode.
            if (this.settings.strict && this.mode === "math") {
                this.settings.reportNonstrict("unicodeTextInMathMode",
                    `Accented Unicode text character "${text[0]}" used in ` +
                    `math mode`, nucleus);
            }
            text = unicodeSymbols[text[0]] + text.substr(1);
        }
        // Strip off any combining characters
        const match = combiningDiacriticalMarksEndRegex.exec(text);
        if (match) {
            text = text.substring(0, match.index);
            if (text === 'i') {
                text = '\u0131';  // dotless i, in math and text mode
            } else if (text === 'j') {
                text = '\u0237';  // dotless j, in math and text mode
            }
        }
        // Recognize base symbol
        let symbol: AnyParseNode;
        if (symbols[this.mode][text]) {
            if (this.settings.strict && this.mode === 'math' &&
                extraLatin.indexOf(text) >= 0) {
                this.settings.reportNonstrict("unicodeTextInMathMode",
                    `Latin-1/Unicode text character "${text[0]}" used in ` +
                    `math mode`, nucleus);
            }
            const group: Group = symbols[this.mode][text].group;
            const loc = SourceLocation.range(nucleus);
            let s: SymbolParseNode;
            if (ATOMS.hasOwnProperty(group)) {
                // $FlowFixMe
                const family: Atom = group;
                s = {
                    type: "atom",
                    mode: this.mode,
                    family,
                    loc,
                    text,
                };
            } else {
                // $FlowFixMe
                s = {
                    type: group,
                    mode: this.mode,
                    loc,
                    text,
                };
            }
            symbol = s;
        } else if (text.charCodeAt(0) >= 0x80) { // no symbol for e.g. ^
            if (this.settings.strict) {
                if (!supportedCodepoint(text.charCodeAt(0))) {
                    this.settings.reportNonstrict("unknownSymbol",
                        `Unrecognized Unicode character "${text[0]}"` +
                        ` (${text.charCodeAt(0)})`, nucleus);
                } else if (this.mode === "math") {
                    this.settings.reportNonstrict("unicodeTextInMathMode",
                        `Unicode text character "${text[0]}" used in math mode`,
                        nucleus);
                }
            }
            // All nonmathematical Unicode characters are rendered as if they
            // are in text mode (wrapped in \text) because that's what it
            // takes to render them in LaTeX.  Setting `mode: this.mode` is
            // another natural choice (the user requested math mode), but
            // this makes it more difficult for getCharacterMetrics() to
            // distinguish Unicode characters without metrics and those for
            // which we want to simulate the letter M.
            symbol = {
                type: "textord",
                mode: "text",
                loc: SourceLocation.range(nucleus),
                text,
            };
        } else {
            return null;  // EOF, ^, _, {, }, etc.
        }
        this.consume();
        // Transform combining characters into accents
        if (match) {
            for (let i = 0; i < match[0].length; i++) {
                const accent: string = match[0][i];
                if (!unicodeAccents[accent]) {
                    throw new ParseError(`Unknown accent ' ${accent}'`, nucleus);
                }
                const command = unicodeAccents[accent][this.mode];
                if (!command) {
                    throw new ParseError(
                        `Accent ${accent} unsupported in ${this.mode} mode`,
                        nucleus);
                }
                symbol = {
                    type: "accent",
                    mode: this.mode,
                    loc: SourceLocation.range(nucleus),
                    label: command,
                    isStretchy: false,
                    isShifty: true,
                    base: symbol,
                };
            }
        }
        return symbol;
    }
}
