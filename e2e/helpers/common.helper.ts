import { Payment, Transaction } from 'bitcoinjs-lib';
import { IndexerService } from '@/indexer/indexer.service';
import { SATS_PER_BTC } from '@/common/constants';
import * as currency from 'currency.js';
import { varIntSize } from '@/common/common';

export function generateScantweak(
    transaction: Transaction,
    outputs: Payment[],
    indexerService: IndexerService,
): string {
    const txid = transaction.getId();

    const txin = transaction.ins.map((input, index) => {
        const isWitness = transaction.hasWitnesses();

        return {
            txid: Buffer.from(input.hash).reverse().toString('hex'),
            vout: input.index,
            scriptSig: isWitness
                ? ''
                : Buffer.from(input.script).toString('hex'),
            witness: isWitness
                ? input.witness.map((v) => Buffer.from(v).toString('hex'))
                : undefined,
            prevOutScript: Buffer.from(outputs[index].output).toString('hex'),
        };
    });

    const txout = transaction.outs.map((output) => ({
        scriptPubKey: Buffer.from(output.script).toString('hex'),
        value: Number(output.value),
    }));

    const scantweak = indexerService.computeScantweak(txid, txin, txout)[0];

    return scantweak.toString('hex');
}

export const readVarInt = (data: Buffer, cursor: number): number => {
    const firstByte = data.readUInt8(cursor);
    if (firstByte < 0xfd) {
        return firstByte;
    } else if (firstByte === 0xfd) {
        return data.readUInt16LE(cursor + 1);
    } else if (firstByte === 0xfe) {
        return data.readUInt32LE(cursor + 1);
    } else {
        return Number(data.readBigUInt64LE(cursor + 1));
    }
};

export interface SilentBlockTransaction {
    txid: string;
    outputs: {
        value: number;
        pubkey: string;
        vout: number;
    }[];
    scanTweak: string;
}

export interface SilentBlock {
    type: number;
    transactions: SilentBlockTransaction[];
}

export const parseSilentBlock = (data: Buffer): SilentBlock => {
    const type = data.readUInt8(0);
    const transactions: SilentBlockTransaction[] = [];

    let cursor = 1;
    const count = readVarInt(data, cursor);
    cursor += varIntSize(count);

    for (let i = 0; i < count; i++) {
        const txid = data.subarray(cursor, cursor + 32).toString('hex');
        cursor += 32;

        const outputs = [];
        const outputCount = readVarInt(data, cursor);
        cursor += varIntSize(outputCount);

        for (let j = 0; j < outputCount; j++) {
            const value = Number(data.readBigUInt64BE(cursor));
            cursor += 8;

            const pubkey = data.subarray(cursor, cursor + 32).toString('hex');
            cursor += 32;

            const vout = data.readUint32BE(cursor);
            cursor += 4;

            outputs.push({ value, pubkey, vout });
        }

        const scanTweak = data.subarray(cursor, cursor + 33).toString('hex');
        cursor += 33;

        transactions.push({ txid, outputs, scanTweak });
    }

    return { type, transactions };
};

export const convertToSatoshi = (amount: number): number => {
    return currency(amount, { precision: 8 }).multiply(SATS_PER_BTC).value;
};
