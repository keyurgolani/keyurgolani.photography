/** One photograph in the Home sequence. #4 extends it with authored fields. */
export type HomePhoto = {
    id: string;
    accessibleName: string;
    sources: { thumbnail: string; full: string };
    width: number;
    height: number;
};
