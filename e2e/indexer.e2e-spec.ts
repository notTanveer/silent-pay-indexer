import { WalletHelper } from '@e2e/helpers/wallet.helper';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { parseSilentBlock } from '@/common/common';
import { Payment, Transaction } from 'bitcoinjs-lib';
import { computeScantweak } from '@/indexer/indexer.service';


function generateScantweak(
    transaction: Transaction,
    outputs: Payment[],
): string {
    const txid = transaction.getId();
    const txin = transaction.ins.map((input, index) => {
        return {
            txid: Buffer.from(input.hash).reverse().toString('hex'),
            vout: input.index,
            scriptSig: transaction.hasWitnesses()
                ? ''
                : Buffer.from(input.script).toString('hex'),
            witness: transaction.hasWitnesses()
                ? input.witness.map((v) => Buffer.from(v).toString('hex'))
                : undefined,
            prevOutScript: Buffer.from(outputs[index].output).toString('hex'),
        };
    });

    console.log(txin);
    const txout = transaction.outs.map((output) => {
        return {
            scriptPubKey: Buffer.from(output.script).toString('hex'),
            value: Number(output.value),
        };
    });

    console.log(txout);

    const scantweak = computeScantweak(txid, txin, txout)[0];

    return scantweak.toString('hex');
}

describe('WalletHelper Integration Tests', () => {
    let walletHelper: WalletHelper;
    let bitcoinRPCUtil: BitcoinRPCUtil;
    let apiHelper: ApiHelper;
    let initialAddress: string;
    let p2wkhOutputs: Payment[];
    let taprootOutput: Payment;
    let utxos: { txid: string; vout: number; value: number; rawTx: string }[];

    beforeAll(async () => {
        walletHelper = new WalletHelper();
        bitcoinRPCUtil = new BitcoinRPCUtil();
        apiHelper = new ApiHelper();

        // await bitcoinRPCUtil.createWallet('test_wallet1');
        initialAddress = await bitcoinRPCUtil.getNewAddress();
        taprootOutput = walletHelper.generateAddresses(1, 'p2tr')[0];
        p2wkhOutputs = walletHelper.generateAddresses(6, 'p2wpkh');
        await bitcoinRPCUtil.mineToAddress(101, initialAddress);

        const txidList = [];
        for (const output of p2wkhOutputs) {
            const txid = await bitcoinRPCUtil.sendToAddress(output.address, 1);
            txidList.push(txid);
        }
        await bitcoinRPCUtil.mineToAddress(6, initialAddress);

        utxos = [];
        for (let i = 0; i < 6; i++) {
            for (let vout = 0; vout < 2; vout++) {
                const utxo = await bitcoinRPCUtil.getTxOut(txidList[i], vout);
                console.log("this is utxo", utxo);
                if (
                    utxo &&
                    utxo.scriptPubKey.address === p2wkhOutputs[i].address
                ) {
                    utxos.push({
                        txid: txidList[i],
                        vout: vout,
                        value: Math.round(utxo.value * 1e8),
                        rawTx: await bitcoinRPCUtil.getRawTransaction(
                            txidList[i],
                        ),
                    });
                    break;
                }
            }
        }
        console.log(utxos);
    });

    it('should craft and broadcast transactions, then verify them', async () => {
        const transaction = walletHelper.craftTransaction(
            utxos.slice(0, 6),
            taprootOutput, // Send 5 BTC to taproot address with 1 BTC fee
        );

        await bitcoinRPCUtil.sendRawTransaction(transaction.toHex());
        const blockHash = (
            await bitcoinRPCUtil.mineToAddress(1, initialAddress)
        )[0];
        console.log(blockHash);

        await new Promise((resolve) => setTimeout(resolve, 30000));

        const response = await apiHelper.get(
            `/silent-block/hash/${blockHash}`,
            {
                responseType: 'arraybuffer',
            },
        );
        const silentBlock = response.data;

        console.log(silentBlock);
        console.log(Buffer.isBuffer(silentBlock));
        const decodedBlock = parseSilentBlock(silentBlock); // Buffer.from(silentBlock, 'binary'),
        const transactions = decodedBlock.transactions;

        console.log(transactions);

        const foundTx = transactions.find(
            (tx: any) => tx.txid === transaction.getId(),
        );

        expect(foundTx).toBeDefined();
        expect(foundTx.outputs.length).toBe(1);

        const output = foundTx.outputs[0];
        console.log(output);
        expect(output).toBeDefined();
        expect(output.value).toEqual(5.999 * 1e8);

        const uint8Array = new Uint8Array(taprootOutput.pubkey);
        const buffer = Buffer.from(uint8Array);
        const hexString = buffer.toString('hex');

        expect(output.pubkey).toEqual(hexString);

        const scantweak = generateScantweak(transaction, p2wkhOutputs);
        expect(foundTx.scanTweak).toEqual(scantweak);
    });
});
