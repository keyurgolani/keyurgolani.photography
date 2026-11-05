/**
 * `/work`'s error shell after `</head>`, as B12's first heavy run read it
 * (slot 1 on 8ec29333, `v2-b12-slot1-run1.log`): the production build, before
 * the launch, as Twitterbot, with script contents already taken out by
 * withoutScripts(). Next's normal shell: one hidden div holding an empty
 * Suspense boundary, then the scripts. B1's fix took the streamed `<title>`
 * out of it, not that div.
 */
export const WORK_ERROR_BODY =
    '<body><div hidden=""><!--$--><!--/$--></div><script id="_R_"></script><script src="/_next/static/chunks/1zr2mrt26dx_4.js" async=""></script><script></script><script></script></body></html>';
