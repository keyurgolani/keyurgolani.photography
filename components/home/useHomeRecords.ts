'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';
// Types only: the projection is server-only.
import type { HomePhoto } from '@/lib/catalog/projections/home';
import { createRouteBuilder, type RouteBuilder } from '@/lib/catalog/routes';

const PUBLIC_ROUTES = createRouteBuilder();

/**
 * Home's records endpoint for the window around `photoId`, bound to the
 * revision Home rendered: the public one, or a preview's mirror (#16) under
 * the site's `basePath`.
 */
export function homePhotosHref(photoId: string, revisionId: string, routes: Pick<RouteBuilder, 'catalogApiHref'> = PUBLIC_ROUTES): string {
  return routes.catalogApiHref(`home/photos/${encodeURIComponent(photoId)}?revision=${encodeURIComponent(revisionId)}`);
}

export interface HomeRecords {
  /** The records Home holds, by ID: the server's window, then each window it asked for. */
  records: ReadonlyMap<string, HomePhoto>;
  /** Photos whose record couldn't be fetched. A photo with no record and not here is still loading. */
  failed: ReadonlySet<string>;
  /** Ask again for the window around a photo whose record failed. */
  retry: (photoId: string) => void;
}

interface Options {
  revisionId: string;
  /** The whole authored order. */
  photoIds: readonly string[];
  /** The server's window: the opening photograph and its neighbors. */
  initial: readonly HomePhoto[];
  /** The position useHomePlayback is on. */
  index: number;
}

const mod = (value: number, count: number) => ((value % count) + count) % count;

/**
 * Home's records beyond the server's window (#6). Home ships every ID but
 * only three records; as it moves, this asks `/api/catalog/home/photos/<id>`
 * for the next window one step ahead in the direction of travel, so the
 * photograph CatalogSequence preloads never waits on its record.
 *
 * - Each request has its own AbortController, and all of them abort on
 *   unmount: leaving Home, or a revision change, since CatalogHome keys the
 *   featured Home by revision.
 * - A record joins only from a response for the rendered revision, and only
 *   for an ID in the sequence, so two revisions never mix.
 * - A 409 means another revision is live: one router.refresh() re-renders
 *   Home from it, and the new key replaces the whole sequence in one update.
 * - Anything else that fails marks the photos it was for as failed, which
 *   Home shows with Retry and Skip. Already loaded photographs stay usable.
 */
export function useHomeRecords({ revisionId, photoIds, initial, index }: Options): HomeRecords {
  const router = useRouter();
  const routes = useSiteRoutes();
  const [records, setRecords] = useState<ReadonlyMap<string, HomePhoto>>(() => new Map(initial.map((record) => [record.id, record] as const)));
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  /** IDs a live request is fetching, each with the request's controller. */
  const pending = useRef(new Map<string, AbortController>());
  const controllers = useRef(new Set<AbortController>());
  const refreshed = useRef(false);
  const previous = useRef(index);

  useEffect(() => {
    const active = controllers.current;
    const inFlight = pending.current;
    return () => {
      for (const controller of active) controller.abort();
      active.clear();
      // Nothing is in flight any more, so a remount (React's development check) asks again.
      inFlight.clear();
    };
  }, []);

  const request = useCallback(
    (centerId: string) => {
      const count = photoIds.length;
      const at = photoIds.indexOf(centerId);
      if (at === -1) return;
      const covers = [...new Set([at - 1, at, at + 1].map((value) => photoIds[mod(value, count)]))];
      const controller = new AbortController();
      for (const id of covers) pending.current.set(id, controller);
      controllers.current.add(controller);
      const settle = () => {
        controllers.current.delete(controller);
        // Only this request's claims: a later request may have taken an ID since.
        for (const id of covers) if (pending.current.get(id) === controller) pending.current.delete(id);
      };
      const fail = () => {
        setFailed((current) => {
          const next = new Set(current);
          for (const id of covers) next.add(id);
          return next;
        });
      };
      const known = new Set(photoIds);
      fetch(homePhotosHref(centerId, revisionId, routes), { signal: controller.signal, headers: { Accept: 'application/json' } })
        .then(async (response) => {
          // Aborted (unmounted, or React's development remount): free the IDs so a live request can ask for them.
          if (controller.signal.aborted) return settle();
          if (response.status === 409) {
            settle();
            if (!refreshed.current) {
              refreshed.current = true;
              router.refresh();
            }
            return;
          }
          if (!response.ok) throw new Error(`status ${response.status}`);
          const body = (await response.json()) as { revisionId?: unknown; photos?: unknown };
          if (body.revisionId !== revisionId || !Array.isArray(body.photos)) throw new Error('unexpected body');
          const photos = (body.photos as HomePhoto[]).filter((photo) => typeof photo?.id === 'string' && known.has(photo.id));
          settle();
          setRecords((current) => {
            const next = new Map(current);
            for (const photo of photos) if (!next.has(photo.id)) next.set(photo.id, photo);
            return next;
          });
          setFailed((current) => {
            if (!photos.some((photo) => current.has(photo.id))) return current;
            const next = new Set(current);
            for (const photo of photos) next.delete(photo.id);
            return next;
          });
          // Asked for but not sent back: treat as failed, so Home never waits on it forever.
          if (covers.some((id) => !photos.some((photo) => photo.id === id))) {
            setFailed((current) => {
              const next = new Set(current);
              for (const id of covers) if (!photos.some((photo) => photo.id === id)) next.add(id);
              return next;
            });
          }
        })
        .catch(() => {
          settle();
          if (!controller.signal.aborted) fail();
        });
    },
    [photoIds, revisionId, router, routes],
  );

  useEffect(() => {
    const count = photoIds.length;
    if (count === 0) return;
    const from = previous.current;
    previous.current = index;
    // Backwards on Previous, including the wrap from the first photograph to the last; forwards otherwise.
    const step = (from === 0 && index === count - 1 && count > 2) || (index === from - 1) ? -1 : 1;
    const wanted = [index - step, index, index + step, index + 2 * step].map((value) => photoIds[mod(value, count)]);
    const missing = (id: string) => !records.has(id) && !pending.current.has(id) && !failed.has(id);
    if (!wanted.some(missing)) return;
    const current = photoIds[index];
    request(missing(current) ? current : photoIds[mod(index + step, count)]);
  }, [index, photoIds, records, failed, request]);

  const retry = useCallback(
    (photoId: string) => {
      setFailed((current) => {
        if (!current.has(photoId)) return current;
        const next = new Set(current);
        next.delete(photoId);
        return next;
      });
      if (!records.has(photoId) && !pending.current.has(photoId)) request(photoId);
    },
    [records, request],
  );

  // A window can fail after some of its photos already arrived from another one; those aren't failed.
  const missingFailed = useMemo(() => new Set([...failed].filter((id) => !records.has(id))), [failed, records]);
  return { records, failed: missingFailed, retry };
}
