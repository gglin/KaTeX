// @flow
import defineFunction from "../defineFunction";
import {calculateSize} from "../units";
import {Input} from "../domTree";
import mathMLTree from "../mathMLTree";
import {assertNodeType} from "../parseNode";
import type {CssStyle} from "../domTree";

defineFunction({
    type: "zInput",
    names: ["\\zInput"],
    props: {
        numArgs: 1,
        numOptionalArgs: 1,
        argTypes: ["size", "raw"],
        allowedInText: true,
    },
    handler: ({parser}, args, optArgs) => {
        let width = {number: 1.7, unit: "em"};
        if (optArgs[0]) {
            width = assertNodeType(optArgs[0], "size").value;
        }

        const index = parseInt(assertNodeType(args[0], "raw").string);

        return {
            type: "zInput",
            mode: parser.mode,
            index: index,
            width: width,
        };
    },
    htmlBuilder: (group, options) => {
        let width = 0;
        if (group.width.number > 0) {
            width = calculateSize(group.width, options);
        }

        const style: CssStyle = {width: width + "em"};

        const node = new Input(group.index, style);

        return node;
    },
    mathmlBuilder: (group, options) => {
        const node = new mathMLTree.MathNode("mglyph", []);

        if (group.width.number > 0) {
            const width = calculateSize(group.width, options);
            node.setAttribute("width", width + "em");
        }
        node.setAttribute("data-idx", group.index.toString());
        return node;
    },
});
