import { open, RootDatabase } from 'lmdb';
import { BatchWriter } from '@/storage/batch-writer';
import { EnvLease, GLOBAL_ORDER } from '@/storage/partition-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const KEY = Buffer.from('k');
const VALUE = Buffer.from('v');

describe('BatchWriter', () => {
    let tmpDir: string;
    let envs: RootDatabase<Buffer, Buffer>[];
    let released: number[];

    const openEnv = (name: string) => {
        const db = open<Buffer, Buffer>({
            path: path.join(tmpDir, name),
            keyEncoding: 'binary',
            encoding: 'binary',
            mapSize: 8 * 1024 * 1024,
        });
        envs.push(db);
        return db;
    };

    const lease = (
        db: RootDatabase<Buffer, Buffer>,
        order: number,
    ): EnvLease => ({
        db,
        order,
        release: () => released.push(order),
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-writer-test-'));
        envs = [];
        released = [];
    });

    afterEach(async () => {
        await Promise.all(envs.map((db) => db.close()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('routes operations to the environment they were queued against', async () => {
        const a = openEnv('a');
        const b = openEnv('b');

        const batch = new BatchWriter();
        batch.put(lease(a, 0), KEY, Buffer.from('from-a'));
        batch.put(lease(b, 1), KEY, Buffer.from('from-b'));
        await batch.commit();

        expect(Buffer.from(a.getBinary(KEY)).toString()).toBe('from-a');
        expect(Buffer.from(b.getBinary(KEY)).toString()).toBe('from-b');
    });

    it('commits partitions in order and the global environment last', async () => {
        const order: number[] = [];
        const spy = (db: RootDatabase<Buffer, Buffer>, at: number) => {
            // Delegates to the real implementation: putSync opens a
            // transaction of its own when none is active, which would
            // re-enter a stubbed transactionSync and double-count.
            const real = db.transactionSync.bind(db);
            let depth = 0;
            jest.spyOn(db, 'transactionSync').mockImplementation(((
                fn: () => unknown,
            ) => {
                if (depth++ === 0) order.push(at);
                try {
                    return real(fn);
                } finally {
                    depth--;
                }
            }) as any);
        };

        const global = openEnv('global');
        const partitionOne = openEnv('p1');
        const partitionTwo = openEnv('p2');
        spy(global, GLOBAL_ORDER);
        spy(partitionOne, 1);
        spy(partitionTwo, 2);

        const batch = new BatchWriter();
        // Queued global-first on purpose: commit order must not follow it.
        batch.put(lease(global, GLOBAL_ORDER), KEY, VALUE);
        batch.put(lease(partitionTwo, 2), KEY, VALUE);
        batch.put(lease(partitionOne, 1), KEY, VALUE);
        await batch.commit();

        expect(order).toEqual([1, 2, GLOBAL_ORDER]);
    });

    it('leaves data without state, never state without data, if a commit fails', async () => {
        const partition = openEnv('p1');
        const global = openEnv('global');
        jest.spyOn(global, 'transactionSync').mockImplementation(() => {
            throw new Error('global commit failed');
        });

        const batch = new BatchWriter();
        batch.put(lease(partition, 0), KEY, Buffer.from('block-data'));
        batch.put(
            lease(global, GLOBAL_ORDER),
            KEY,
            Buffer.from('resume-point'),
        );

        await expect(batch.commit()).rejects.toThrow('global commit failed');

        // The recoverable shape: the data is there, the resume pointer is not,
        // so restarting re-indexes those blocks and converges.
        expect(Buffer.from(partition.getBinary(KEY)).toString()).toBe(
            'block-data',
        );
        expect(global.getBinary(KEY)).toBeFalsy();
    });

    it('holds one lease per environment however many are handed over', async () => {
        const db = openEnv('a');

        const batch = new BatchWriter();
        const first = batch.adopt(lease(db, 0));
        const second = batch.adopt(lease(db, 0));

        // The duplicate is released immediately; the batch keeps the original.
        expect(second).toBe(first);
        expect(released).toEqual([0]);

        batch.dispose();
        expect(released).toEqual([0, 0]);
    });

    it('keeps its own lease when the same one is handed back', async () => {
        const db = openEnv('a');

        const batch = new BatchWriter();
        const held = batch.adopt(lease(db, 0));
        // Every put after the first re-adopts the lease the batch is already
        // holding. Treating that as surplus would unpin the environment and
        // let the LRU close it mid-batch.
        batch.put(held, KEY, VALUE);
        batch.put(held, Buffer.from('k2'), VALUE);

        expect(released).toEqual([]);

        await batch.commit();
        expect(released).toEqual([0]);
    });

    it('coalesces repeated putOnce and delOnce of the same key', async () => {
        const db = openEnv('a');
        const held = { db, order: 0, release: () => released.push(0) };
        const writes: string[] = [];
        jest.spyOn(db, 'putSync').mockImplementation(((key: Buffer) => {
            writes.push(`put:${key.toString()}`);
            return true;
        }) as any);
        jest.spyOn(db, 'removeSync').mockImplementation(((key: Buffer) => {
            writes.push(`del:${key.toString()}`);
            return true;
        }) as any);

        const batch = new BatchWriter();
        // Stands in for the `idx:bt:` index: one entry per block, derived
        // again by every transaction in that block.
        for (let i = 0; i < 5; i++) batch.putOnce(held, KEY, VALUE);
        batch.putOnce(held, Buffer.from('other'), VALUE);
        for (let i = 0; i < 5; i++) batch.delOnce(held, Buffer.from('gone'));
        await batch.commit();

        expect(writes).toEqual(['put:k', 'put:other', 'del:gone']);
    });

    it('keeps putOnce and delOnce of the same key independent', async () => {
        const db = openEnv('a');
        const held = { db, order: 0, release: () => released.push(0) };

        const batch = new BatchWriter();
        batch.putOnce(held, KEY, VALUE);
        batch.delOnce(held, KEY);
        await batch.commit();

        // Queued in that order, so the delete is what survives — the put
        // must not have been swallowed as an already-seen key.
        expect(db.getBinary(KEY)).toBeFalsy();
    });

    it('writes nothing and releases everything when disposed', async () => {
        const db = openEnv('a');

        const batch = new BatchWriter();
        batch.put(lease(db, 0), KEY, VALUE);
        batch.dispose();

        expect(db.getBinary(KEY)).toBeFalsy();
        expect(released).toEqual([0]);

        // Idempotent: DbTransactionService disposes in a finally, after a
        // successful commit has already done so.
        batch.dispose();
        expect(released).toEqual([0]);
    });

    it('releases every lease even when a commit throws', async () => {
        const partition = openEnv('p1');
        const global = openEnv('global');
        jest.spyOn(global, 'transactionSync').mockImplementation(() => {
            throw new Error('boom');
        });

        const batch = new BatchWriter();
        batch.put(lease(partition, 0), KEY, VALUE);
        batch.put(lease(global, GLOBAL_ORDER), KEY, VALUE);

        await expect(batch.commit()).rejects.toThrow('boom');
        expect(released.sort()).toEqual([0, GLOBAL_ORDER]);
    });
});
