/**
 * Test-only preload, for the owner-gate pins (lib/catalog/__tests__/ownerGatePins.test.ts):
 * with PHOTOS_TEST_UID set, process.geteuid() and process.getuid() answer it, as if the
 * process ran as that user. Loaded with NODE_OPTIONS=--require <this file>; nothing ships it.
 */
const uid = Number(process.env.PHOTOS_TEST_UID);
if (process.env.PHOTOS_TEST_UID !== undefined && Number.isInteger(uid)) {
    process.geteuid = () => uid;
    process.getuid = () => uid;
}
