/**
 * Stops an image that left the page before it finished (#6). A removed <img>
 * keeps fetching until it's collected, so a fast visitor would still be paying
 * for every photograph they passed. Clearing the <picture>'s sources first
 * keeps the image from picking one of them again.
 */
export function stopFetching(image: HTMLImageElement): void {
    const picture = image.parentElement;
    if (picture?.tagName === 'PICTURE') for (const source of picture.querySelectorAll('source')) source.removeAttribute('srcset');
    image.removeAttribute('srcset');
    image.removeAttribute('src');
}
