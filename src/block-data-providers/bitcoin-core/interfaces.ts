import { TransactionInput, TransactionOutput } from '@/indexer/indexer.service';

export interface Block {
    time: number;
    height: number;
    hash: string;
    tx: BlockTransaction[];
}

export interface BlockTransaction {
    txid: string;
    hash: string;
    vin: Input[];
    vout: Output[];
    /**
     * Only present when the transaction is confirmed, and only on the
     * standalone `getrawtransaction` payload — a transaction read out of
     * `getblock` does not repeat it.
     */
    blockhash?: string;
}

export interface BlockHeader {
    height: number;
    time: number;
}

export interface NetworkInfo {
    version: number;
}

export interface Input {
    txid: string;
    vout: number;
    scriptSig: {
        hex: string;
    };
    /** Present only on a coinbase input, which has no prevout to spend. */
    coinbase?: string;
    prevout?: {
        scriptPubKey: {
            hex: string;
        };
    };
    txinwitness: string[];
}

export interface Output {
    value: number;
    n: number;
    scriptPubKey: {
        hex: string;
    };
}

export type BitcoinCoreOperationState = {
    indexedBlockHeight: number;
};

export type Transaction = {
    txid: string;
    vin: TransactionInput[];
    vout: TransactionOutput[];
    blockHeight: number;
    blockHash: string;
};

export interface RPCRequestBody {
    method: string;
    params: (string | number | boolean)[];
}
