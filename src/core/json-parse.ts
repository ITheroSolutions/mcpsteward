/**
 * A JSON parser that preserves number tokens.
 *
 * `JSON.parse` is unusable for hashing. It converts every number to an IEEE 754
 * double, which silently destroys two things that matter here:
 *
 * - **Precision.** `9007199254740993` parses to `9007199254740992`. Two
 *   semantically different tool schemas would hash identically, which is exactly
 *   the failure a trust ledger exists to prevent.
 * - **Distinctions we must decide about deliberately.** `1e2` and `100` are the
 *   same number and must hash the same. `1.0` and `1` likewise. Those are
 *   decisions the canonicalizer should make from the token, not accidents of
 *   double conversion.
 *
 * So the surface capture path parses with this instead, and every number arrives
 * as a {@link JsonNumber} carrying its original text.
 *
 * The parser is strict RFC 8259: no comments, no trailing commas, no `NaN`, no
 * `Infinity`, no single quotes, no leading zeros, no leading plus.
 */

import { ProtocolViolationError } from './errors.js';

/** A number preserved as its original source token. */
export interface JsonNumber {
  readonly __jsonNumber: true;
  /** The exact token as it appeared in the source text. */
  readonly token: string;
}

/**
 * A JSON object.
 *
 * Declared as an interface with an index signature rather than
 * `Readonly<Record<string, JsonValue>>`, because a mapped type cannot be resolved
 * lazily and the recursive reference to `JsonValue` becomes a circular type alias
 * error. Interfaces are resolved lazily and so can close the loop.
 */
// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = string | boolean | null | JsonNumber | readonly JsonValue[] | JsonObject;

export function isJsonNumber(value: unknown): value is JsonNumber {
  return typeof value === 'object' && value !== null && '__jsonNumber' in value;
}

export function jsonNumber(token: string): JsonNumber {
  return { __jsonNumber: true, token };
}

/**
 * Maximum nesting depth.
 *
 * A hostile server can send `[[[[[...]]]]]` and blow the stack. The specification
 * itself asks implementations to bound schema depth as a denial of service
 * defence (MS-TOOL-005); the same reasoning applies to the parser underneath.
 */
const MAX_DEPTH = 512;

class JsonParser {
  private index = 0;
  private depth = 0;

  constructor(private readonly text: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();

    if (this.index < this.text.length) {
      this.fail(`unexpected trailing content at position ${String(this.index)}`);
    }

    return value;
  }

  private fail(message: string): never {
    throw new ProtocolViolationError(`Invalid JSON: ${message}`, {
      details: { position: this.index },
    });
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const ch = this.text.charCodeAt(this.index);
      // Space, tab, line feed, carriage return. RFC 8259 permits no others.
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        this.index += 1;
      } else {
        break;
      }
    }
  }

  private parseValue(): JsonValue {
    if (this.index >= this.text.length) this.fail('unexpected end of input');

    if (this.depth > MAX_DEPTH) {
      this.fail(`maximum nesting depth of ${String(MAX_DEPTH)} exceeded`);
    }

    const ch = this.text[this.index];

    switch (ch) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        this.expect('true');
        return true;
      case 'f':
        this.expect('false');
        return false;
      case 'n':
        this.expect('null');
        return null;
      default:
        return this.parseNumber();
    }
  }

  private expect(literal: string): void {
    if (!this.text.startsWith(literal, this.index)) {
      this.fail(`expected ${literal} at position ${String(this.index)}`);
    }
    this.index += literal.length;
  }

  private parseObject(): JsonObject {
    this.index += 1; // consume {
    this.depth += 1;
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;

    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      this.depth -= 1;
      return result;
    }

    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail('expected an object key');

      const key = this.parseString();
      this.skipWhitespace();

      if (this.text[this.index] !== ':') this.fail('expected : after an object key');
      this.index += 1;

      this.skipWhitespace();
      const value = this.parseValue();

      // A duplicate key is not a parse error in RFC 8259, but it is an ambiguity
      // no hashing scheme can resolve honestly: last-wins and first-wins produce
      // different hashes for the same bytes. Reject rather than pick.
      if (key in result) {
        this.fail(`duplicate object key ${JSON.stringify(key)}`);
      }
      result[key] = value;

      this.skipWhitespace();
      const next = this.text[this.index];

      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === '}') {
        this.index += 1;
        this.depth -= 1;
        return result;
      }
      this.fail('expected , or } in an object');
    }
  }

  private parseArray(): readonly JsonValue[] {
    this.index += 1; // consume [
    this.depth += 1;
    const result: JsonValue[] = [];

    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      this.depth -= 1;
      return result;
    }

    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();

      const next = this.text[this.index];
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === ']') {
        this.index += 1;
        this.depth -= 1;
        return result;
      }
      this.fail('expected , or ] in an array');
    }
  }

  private parseString(): string {
    this.index += 1; // consume opening quote
    let out = '';

    for (;;) {
      if (this.index >= this.text.length) this.fail('unterminated string');

      const ch = this.text.charAt(this.index);

      if (ch === '"') {
        this.index += 1;
        return out;
      }

      if (ch === '\\') {
        this.index += 1;
        out += this.parseEscape();
        continue;
      }

      // RFC 8259 forbids unescaped control characters in strings.
      const code = this.text.charCodeAt(this.index);
      if (code < 0x20) {
        this.fail(`unescaped control character U+${code.toString(16).padStart(4, '0')}`);
      }

      out += ch;
      this.index += 1;
    }
  }

  private parseEscape(): string {
    const ch = this.text.charAt(this.index);
    this.index += 1;

    switch (ch) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
        this.index += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        return this.fail(`invalid escape \\${ch}`);
    }
  }

  /**
   * Parse a number, returning its exact source token.
   *
   * Grammar per RFC 8259: an optional minus, an integer part with no leading
   * zeros, an optional fraction, and an optional exponent. Deliberately strict:
   * `+1`, `01`, `.5`, `1.`, `NaN` and `Infinity` are all rejected, because
   * accepting them would mean inventing a canonical form for input the
   * specification does not permit.
   */
  private parseNumber(): JsonNumber {
    const start = this.index;

    if (this.text[this.index] === '-') this.index += 1;

    // Integer part.
    if (this.text[this.index] === '0') {
      this.index += 1;
      // A leading zero may not be followed by another digit.
      if (this.isDigit(this.text[this.index])) this.fail('leading zeros are not allowed');
    } else if (this.isDigit(this.text[this.index])) {
      while (this.isDigit(this.text[this.index])) this.index += 1;
    } else {
      this.fail(`unexpected character ${JSON.stringify(this.text[this.index] ?? '')}`);
    }

    // Fraction.
    if (this.text[this.index] === '.') {
      this.index += 1;
      if (!this.isDigit(this.text[this.index])) this.fail('expected a digit after the decimal point');
      while (this.isDigit(this.text[this.index])) this.index += 1;
    }

    // Exponent.
    const exp = this.text[this.index];
    if (exp === 'e' || exp === 'E') {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === '+' || sign === '-') this.index += 1;
      if (!this.isDigit(this.text[this.index])) this.fail('expected a digit in the exponent');
      while (this.isDigit(this.text[this.index])) this.index += 1;
    }

    return jsonNumber(this.text.slice(start, this.index));
  }

  private isDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= '0' && ch <= '9';
  }
}

/**
 * Parse JSON, preserving every number as its original token.
 *
 * @throws {ProtocolViolationError} when the text is not valid RFC 8259 JSON, or
 * contains a duplicate object key, or nests beyond the maximum depth.
 */
export function parseJsonPreservingNumbers(text: string): JsonValue {
  return new JsonParser(text).parse();
}
