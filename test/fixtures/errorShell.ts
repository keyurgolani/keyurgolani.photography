/**
 * `/work`'s error shell after `</head>`, as a production build served it
 * before the launch, as Twitterbot, with script contents already taken out by
 * withoutScripts(). Next's normal shell: one hidden div holding an empty
 * Suspense boundary, then the scripts. Work's own fix took the streamed
 * `<title>` out of it, not that div.
 */
export const WORK_ERROR_BODY =
    '<body><div hidden=""><!--$--><!--/$--></div><script id="_R_"></script><script src="/_next/static/chunks/1zr2mrt26dx_4.js" async=""></script><script></script><script></script></body></html>';
