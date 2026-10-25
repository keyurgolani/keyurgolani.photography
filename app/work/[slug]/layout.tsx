import ViewerHost from '@/components/viewer/ViewerHost';

/**
 * Everything under one series' URL: #5's series page when it's there, and
 * the Viewer, either as a page (`photo/[photoId]`) or as the modal the
 * `@modal` slot intercepts from the series page (#9). The host above both
 * keeps the Viewer's controls mounted across moves. It reads no catalog data,
 * so nothing here can show a series the page itself would refuse.
 */
export default function SeriesLayout({ children, modal }: LayoutProps<'/work/[slug]'>) {
    return <ViewerHost modal={modal}>{children}</ViewerHost>;
}
