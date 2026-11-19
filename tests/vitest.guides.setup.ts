// No test sees the app guides the build happens to carry (dist/guides/pack.json): a guide hint or a guide in a result
// would otherwise change with whichever guides are bundled. Tests of guides point the store at their own files.
// A separate setup file on purpose: it runs after vitest.setup.ts has moved the home directory, so importing the store
// (and with it src/paths) never resolves a path in the real home.
import * as os from 'os';
import * as path from 'path';
import { __setGuidePathsForTests } from '../src/core/guides/store';

const none = path.join(os.tmpdir(), `clawdcursor-test-no-guides-${process.pid}`);
__setGuidePathsForTests({ localDir: path.join(none, 'guides'), cacheFile: path.join(none, 'cache', 'pack.json'), bundledFile: path.join(none, 'pack.json') });
