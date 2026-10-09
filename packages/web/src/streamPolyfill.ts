/**
 * Safari (and some older browsers) cannot loop over a ReadableStream with `for await`, which pdf.js does when it reads
 * a page's text ("undefined is not a function (near '...of t...')"). This adds the missing iterator; it does nothing
 * where the browser already has it.
 */
const proto = (globalThis as unknown as { ReadableStream?: { prototype: Record<symbol | string, unknown> } }).ReadableStream?.prototype;
if (proto && !proto[Symbol.asyncIterator]) {
  const iterate = function (this: ReadableStream, options?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    let done = false;
    return {
      async next() {
        if (done) return { done: true as const, value: undefined };
        try {
          const r = await reader.read();
          if (r.done) {
            done = true;
            reader.releaseLock();
            return { done: true as const, value: undefined };
          }
          return { done: false as const, value: r.value };
        } catch (err) {
          done = true;
          reader.releaseLock();
          throw err;
        }
      },
      async return(value?: unknown) {
        if (!done) {
          done = true;
          if (!options?.preventCancel) await reader.cancel(value).catch(() => undefined);
          reader.releaseLock();
        }
        return { done: true as const, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  proto[Symbol.asyncIterator] = iterate;
  proto["values"] = iterate;
}
export {};
