// Child process for the concurrent-state test: marks `count` distinct lanes
// blocked as fast as it can, so two writers race on one state file.
import { LaneStore } from '../../src/state.js';

const [path, prefix, count] = process.argv.slice(2);
const until = new Date(Date.now() + 3_600_000);
for (let i = 0; i < Number(count); i++) {
  new LaneStore(path).markBlocked(`${prefix}-${i}`, until, 'test');
}
