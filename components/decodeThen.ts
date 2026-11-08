/**
 * Decodes a loaded image, then reports it. A decode that rejects for an image
 * that did load (its source changed under it, as a wider window picks a larger
 * candidate) still counts: the next load decodes again. Without decode(), as
 * in jsdom, the load is the commit.
 */
export function decodeThen(element: HTMLImageElement, live: () => boolean, onDecoded: () => void, onFailed: () => void) {
  if (typeof element.decode !== 'function') {
    onDecoded();
    return;
  }
  element.decode().then(
    () => {
      if (live()) onDecoded();
    },
    () => {
      if (!live()) return;
      if (element.complete && element.naturalWidth > 0) onDecoded();
      else onFailed();
    },
  );
}
