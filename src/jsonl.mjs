import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

// Incrementally folds append-only JSONL logs. Each file keeps a byte offset and a reducer
// state, so a refresh parses only the lines written since the previous one.
export class JsonlTail {
  constructor({ init, reduce }) {
    this.init = init;
    this.reduce = reduce;
    this.files = new Map();
  }

  async read(path) {
    const info = await stat(path);
    let entry = this.files.get(path);
    if (!entry || info.ino !== entry.ino || info.size < entry.offset) {
      entry = { ino: info.ino, offset: 0, rest: '', decoder: new StringDecoder('utf8'), state: this.init(path) };
      this.files.set(path, entry);
    }
    if (info.size > entry.offset) {
      const length = info.size - entry.offset;
      const buffer = Buffer.alloc(length);
      const handle = await open(path, 'r');
      try {
        await handle.read(buffer, 0, length, entry.offset);
      } finally {
        await handle.close();
      }
      entry.offset = info.size;
      const lines = (entry.rest + entry.decoder.write(buffer)).split('\n');
      entry.rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        this.reduce(entry.state, record, line);
      }
    }
    return { state: entry.state, mtimeMs: info.mtimeMs };
  }

  // Drops cached files that have left the time window.
  retain(paths) {
    const keep = new Set(paths);
    for (const path of this.files.keys()) if (!keep.has(path)) this.files.delete(path);
  }
}
