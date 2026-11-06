/**
 * Test-only preload, for the owner-gate pins (lib/catalog/__tests__/ownerGatePins.test.ts):
 * with PHOTOS_TEST_UID set, process.geteuid() answers it, as if the process ran setuid as
 * that user. getuid(), the real uid, stays this process's own, so a gate that compared the
 * real uid instead of the effective one, which owns what the process creates, would let
 * every pin's write through and fail it (A11 round 4). Loaded with
 * NODE_OPTIONS=--require <this file>; nothing ships it.
 */
const uid = Number(process.env.PHOTOS_TEST_UID);
if (process.env.PHOTOS_TEST_UID !== undefined && Number.isInteger(uid)) {
    process.geteuid = () => uid;
}
