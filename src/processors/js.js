import * as acorn from 'https://esm.sh/acorn@8.11.3';
import { simple as walkSimple } from 'https://esm.sh/acorn-walk@8.3.2';
import MagicString from 'https://esm.sh/magic-string@0.30.5';
import { uint8ToString } from './utils.js';
import { normalizeImport } from './imports.js';

export function processJS(jsContent, filename = 'script.js', analyzer) {
    let code = uint8ToString(jsContent);

    // React/JSX Detection: Ensure dependencies are tracked if JSX is present
    if (/<[A-Z][A-Za-z0-9]*[\s>]/g.test(code) || /className=/g.test(code)) {
        if (!analyzer.dependencies['react']) analyzer.dependencies['react'] = '^18.2.0';
        if (!analyzer.dependencies['react-dom']) analyzer.dependencies['react-dom'] = '^18.2.0';
    }
    
    // Generic WebSim URL Replacements (Fix CSP issues & Hot-swap Identity)
    code = code.replace(/https:\/\/images\.websim\.ai\/avatar\/|https:\/\/images\.websim\.com\/avatar\//g, 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png?user=');
    // Replace full literal avatar strings if found
    code = code.replace(/["']https:\/\/images\.websim\.(ai|com)\/avatar\/[^"']+["']/g, '"https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png"');

    // Calculate relative path to root for asset corrections
    const depth = (filename.match(/\//g) || []).length;
    const rootPrefix = depth > 0 ? '../'.repeat(depth) : './';

    let ast;
    const magic = new MagicString(code);
    let hasChanges = false;

    try {
        ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
        
        const rewrite = (node) => {
            if (node.source && node.source.value) {
                const newVal = normalizeImport(node.source.value, analyzer.dependencies);
                if (newVal !== node.source.value) {
                    magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                    hasChanges = true;
                }
            }
        };

        const rewritePaths = (node) => {
            if (node.type === 'Literal' && typeof node.value === 'string') {
                const val = node.value;

                // 1. Check URL Map (Exact Match for external or remapped assets)
                if (analyzer.urlMap.has(val)) {
                    const cleanName = analyzer.urlMap.get(val);
                    // Serve from root (public folder)
                    const newVal = `/${cleanName}`; 
                    magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                    hasChanges = true;
                    return;
                }

                // 2. Handle standard local paths that weren't mapped
                if (val.startsWith('/') && !val.startsWith('//') && /\.(png|jpg|jpeg|gif|mp3|wav|ogg|glb|gltf|svg|json)$/i.test(val)) {
                    const newVal = rootPrefix + val.substring(1);
                    magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                    hasChanges = true;
                }
            }
        };

        walkSimple(ast, {
            ImportDeclaration: rewrite,
            ExportNamedDeclaration: rewrite,
            ExportAllDeclaration: rewrite,
            ImportExpression: (node) => {
                if (node.source.type === 'Literal') {
                    const newVal = normalizeImport(node.source.value, analyzer.dependencies);
                    if (newVal !== node.source.value) {
                        magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                        hasChanges = true;
                    }
                }
            },
            Literal: rewritePaths,
            BinaryExpression: (node) => {
                // Detect concatenation: "https://images.websim.ai/avatar/" + user.username
                if (node.operator === '+') {
                    const left = node.left;
                    const right = node.right;
                    
                    if (left.type === 'Literal' && typeof left.value === 'string') {
                        // Check if string ends with one of the avatar prefixes
                        const match = left.value.match(/(https:\/\/images\.websim\.(?:ai|com)\/avatar\/|https:\/\/www\.redditstatic\.com\/avatars\/avatar_default_02_FF4500\.png\?user=)$/);
                        
                        if (match && right.type === 'MemberExpression' && right.property.name === 'username') {
                            // Safe Replacement: 
                            // 1. Trim the URL from the left string (preserving any HTML before it)
                            const newLeftVal = left.value.substring(0, left.value.length - match[0].length);
                            magic.overwrite(left.start, left.end, JSON.stringify(newLeftVal));
                            
                            // 2. Replace the username access with avatar_url access (with fallback)
                            const objectCode = code.slice(right.object.start, right.object.end);
                            const newRightVal = `(${objectCode}.avatar_url || "https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png")`;
                            magic.overwrite(right.start, right.end, newRightVal);
                            
                            hasChanges = true;
                        }
                    }
                }
            },
            TemplateLiteral: (node) => {
                // Iterate through all expressions in the template literal to find avatar injections
                // e.g. `<img src="https://images.websim.com/avatar/${user.username}">`
                
                node.expressions.forEach((expr, i) => {
                    const quasi = node.quasis[i]; // The string part BEFORE the expression
                    const raw = quasi.value.raw;
                    
                    // Check if this segment ends with an avatar URL prefix
                    const match = raw.match(/(https:\/\/images\.websim\.(?:ai|com)\/avatar\/|https:\/\/www\.redditstatic\.com\/avatars\/avatar_default_02_FF4500\.png\?user=)$/);
                    
                    if (match) {
                        // Check if expression is accessing a 'username' property
                        if (expr.type === 'MemberExpression' && expr.property.type === 'Identifier' && expr.property.name === 'username') {
                            // 1. Remove the URL prefix from the quasi string
                            const prefixLen = match[0].length;
                            // We construct the new raw string without the prefix
                            const newRaw = raw.substring(0, raw.length - prefixLen);
                            magic.overwrite(quasi.start, quasi.end, newRaw);

                            // 2. Replace the expression `user.username` with `user.avatar_url`
                            const objectCode = code.slice(expr.object.start, expr.object.end);
                            const replacement = `(${objectCode}.avatar_url || "https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png")`;
                            magic.overwrite(expr.start, expr.end, replacement);
                            
                            hasChanges = true;
                        }
                    }
                });
            }
        });

    } catch (e) {
        // Regex Fallback for JSX or syntax errors (Acorn fails on JSX)
        // Matches:
        // 1. import ... from "..."
        // 2. import "..."
        // 3. export ... from "..."
        // 4. import("...") (dynamic)
        const importRegex = /(import\s+(?:[\w\s{},*]+)\s+from\s+['"])([^'"]+)(['"])|(import\s+['"])([^'"]+)(['"])|(from\s+['"])([^'"]+)(['"])|(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
        let match;
        const originalCode = code; 
        
        while ((match = importRegex.exec(originalCode)) !== null) {
            const url = match[2] || match[5] || match[8] || match[11];
            const prefix = match[1] || match[4] || match[7] || match[10];
            
            if (url) {
                const newVal = normalizeImport(url, analyzer.dependencies);
                if (newVal !== url) {
                    const start = match.index + prefix.length;
                    const end = start + url.length;
                    magic.overwrite(start, end, newVal);
                    hasChanges = true;
                }
            }
        }
    }

    // Remotion License Injection for <Player /> components
    // We iterate all <Player> tags and ensure the prop is present.
    if (code.includes('<Player')) {
            const playerRegex = /<Player([\s\n\r/>])/g;
            let match;
            while ((match = playerRegex.exec(code)) !== null) {
                // Check if the prop already exists in the vicinity (heuristic: next 500 chars)
                // This avoids duplicate injection if the user already added it or if we run multiple times
                const vicinity = code.slice(match.index, match.index + 500);
                const closeIndex = vicinity.indexOf('>');
                const tagContent = closeIndex > -1 ? vicinity.slice(0, closeIndex) : vicinity;
                
                if (!tagContent.includes('acknowledgeRemotionLicense')) {
                    // Insert prop right after <Player
                    magic.appendLeft(match.index + 7, ' acknowledgeRemotionLicense={true}');
                    hasChanges = true;
                }
            }
    }

    return hasChanges ? magic.toString() : code;
}