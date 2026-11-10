import type { Ctx } from './context';

/**
 * Encoding tricks that hide a protected item from the pattern passes. This runs first, so
 * the passes that follow see the plain form. It touches only invisible characters and
 * tokens that hide an e-mail address or a host name; it never decodes the script as a whole
 * (a global decode would change legitimate text such as date formats).
 *
 * Known limit: values hidden by base64, hex or a cipher are not found. See README.
 */
// soft hyphen, zero-width and joiner characters, bidirectional controls, word joiner, BOM
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const foldFullWidth = (s: string): string => s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
// percent-encoded @ . - _ +
const PCT = /%(40|2[EeDdBb]|5[Ff])/g;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

export function deobfuscate(text: string, ctx: Ctx): string {
  let out = text.replace(INVISIBLE, () => {
    ctx.obfuscated++;
    return '';
  });
  // a token that hides "@" as %40 or as the full-width form
  out = out.replace(/[^\s'"<>()[\]{},;]*(?:%40|\uFF20)[^\s'"<>()[\]{},;]*/g, (tok) => {
    const plain = foldFullWidth(tok).replace(PCT, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    if (!EMAIL_SHAPE.test(plain)) return tok;
    ctx.obfuscated++;
    return plain;
  });
  // a host name whose dots are percent-encoded: name%2Edomain%2Etld
  out = out.replace(/(?<![\w%])[A-Za-z0-9-]+(?:%2[Ee][A-Za-z0-9-]+){2,}(?![\w%])/g, (tok) => {
    ctx.obfuscated++;
    return tok.replace(/%2[Ee]/g, '.');
  });
  return out;
}
