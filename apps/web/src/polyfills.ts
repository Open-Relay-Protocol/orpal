// orpal-core reuses the ORP reference's encoding helpers, which call Node's
// `Buffer` with the **base64url** encoding (e.g. `Buffer.from(s, "base64url")`
// and `buf.toString("base64url")`). Chromium has no Buffer, and the `buffer`
// browser polyfill doesn't implement base64url -- it throws "Unknown encoding:
// base64url". So we install the polyfill AND teach it base64url (standard base64
// with +->-, /->_, padding stripped). This module MUST be imported first in main.tsx.
import { Buffer as BufferPolyfill } from "buffer";

type BufferCtor = typeof BufferPolyfill;

function patchBase64Url(B: BufferCtor): BufferCtor {
  const origFrom = B.from.bind(B) as (value: unknown, encoding?: string) => InstanceType<BufferCtor>;
  const origToString = B.prototype.toString;

  const toB64 = (s: string): string => {
    let v = s.replace(/-/g, "+").replace(/_/g, "/");
    while (v.length % 4 !== 0) v += "=";
    return v;
  };
  const fromB64 = (s: string): string =>
    s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Static Buffer.from(value, "base64url")
  (B as unknown as { from: (value: unknown, encoding?: string) => unknown }).from = function (
    value: unknown,
    encoding?: string,
  ) {
    if (encoding === "base64url" && typeof value === "string") {
      return origFrom(toB64(value), "base64");
    }
    return origFrom(value, encoding);
  };

  // Instance buf.toString("base64url", ...)
  (B.prototype as unknown as { toString: (encoding?: string, ...rest: number[]) => string }).toString =
    function (this: InstanceType<BufferCtor>, encoding?: string, ...rest: number[]): string {
      if (encoding === "base64url") {
        return fromB64(origToString.call(this, "base64"));
      }
      return origToString.call(this, encoding as BufferEncoding, ...(rest as [number?, number?]));
    };

  return B;
}

const g = globalThis as unknown as { Buffer?: BufferCtor };
if (!g.Buffer) g.Buffer = patchBase64Url(BufferPolyfill);
