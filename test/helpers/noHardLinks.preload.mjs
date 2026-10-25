// Loaded with --import into a test's child process, so every link() there fails, as on exFAT.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const unsupported = () => Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' });

fs.linkSync = () => {
    throw unsupported();
};
fs.link = (_existing, _created, callback) => {
    process.nextTick(callback, unsupported());
};
fs.promises.link = async () => {
    throw unsupported();
};
syncBuiltinESMExports();
