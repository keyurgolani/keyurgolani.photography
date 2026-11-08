/**
 * Test-only preload, for the owner-gate pins (lib/catalog/__tests__/ownerGatePins.test.ts):
 * with PHOTOS_TEST_UID set, process.geteuid() answers it, as if the process ran setuid as
 * that user. getuid(), the real uid, stays this process's own, so a gate that compared the
 * real uid instead of the effective one, which owns what the process creates, would let
 * every pin's write through and fail it. Loaded with
 * NODE_OPTIONS=--require <this file>; nothing ships it.
 *
 * With PHOTOS_TEST_ROOT_UID and PHOTOS_TEST_ROOT set too, fs.statSync() of that one folder
 * answers that uid as its owner, so a pin can put the data root in uid 1001's hands, as
 * production does, or root's, as a run as root on the host leaves it, without a chown. Every
 * other path, and the folder's other fields, are the real ones.
 */
const uid = Number(process.env.PHOTOS_TEST_UID);
if (process.env.PHOTOS_TEST_UID !== undefined && Number.isInteger(uid)) {
    process.geteuid = () => uid;
}

const rootUid = Number(process.env.PHOTOS_TEST_ROOT_UID);
const fakedRoot = process.env.PHOTOS_TEST_ROOT;
if (process.env.PHOTOS_TEST_ROOT_UID !== undefined && Number.isInteger(rootUid) && fakedRoot) {
    const fs = require('node:fs');
    const realStatSync = fs.statSync;
    const target = fs.realpathSync(fakedRoot);
    fs.statSync = function statSync(file, options) {
        const stat = realStatSync(file, options);
        if (!stat || typeof file !== 'string') return stat;
        let resolved;
        try { resolved = fs.realpathSync(file); } catch { return stat; }
        if (resolved !== target) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: rootUid });
    };
}
