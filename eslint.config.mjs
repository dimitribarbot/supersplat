import { SourceCode } from 'eslint';
import playcanvasConfig from '@playcanvas/eslint-config';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

// TEMPORARY (remove when upgrading to @playcanvas/eslint-config@^3): eslint@10
// removed SourceCode#getTokenOrCommentBefore/After, but the pinned
// eslint-plugin-import@2.x `order` rule still calls them and aborts the whole
// run on any out-of-order import. Shim them onto the modern includeComments
// variants so the rule reports/fixes instead of crashing.
SourceCode.prototype.getTokenOrCommentBefore ??= function (nodeOrToken) {
    return this.getTokenBefore(nodeOrToken, { includeComments: true });
};
SourceCode.prototype.getTokenOrCommentAfter ??= function (nodeOrToken) {
    return this.getTokenAfter(nodeOrToken, { includeComments: true });
};

export default [
    ...playcanvasConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                BlobPart: 'readonly'
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        settings: {
            'import/resolver': {
                typescript: {}
            }
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns': 'off',
            'jsdoc/require-returns-type': 'off',
            'jsdoc/check-tag-names': 'off',
            'lines-between-class-members': 'off',
            'no-await-in-loop': 'off',
            'require-atomic-updates': 'off'
        }
    }, {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import/no-unresolved': 'off'
        }
    }
];
