import { WalletHelper } from '@e2e/helpers/wallet.helper';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { parseSilentBlock } from '@/common/common';
import { Payment } from 'bitcoinjs-lib';

function hexStringToBuffer(hexString: string): Buffer {
    if (hexString.length % 2 !== 0) {
        throw new Error('Hex string length must be even');
    }

    const buffer = Buffer.alloc(hexString.length / 2);

    for (let i = 0; i < hexString.length; i += 2) {
        const byte = parseInt(hexString.substring(i, i + 2), 16);
        if (isNaN(byte)) {
            throw new Error('Invalid hex character at index ' + i);
        }
        buffer[i / 2] = byte;
    }

    return buffer;
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
        p2wkhOutputs = walletHelper.generateAddresses(8, 'p2wpkh');
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
                if (utxo && Math.round(utxo.value * 1e8) === 1e8) {
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

        const silentBlock1 =
            '00014c916159adfc0aaaa5e2ae2ba282ddf12fef1921ec240440fcced03dd57d9e0f010000000023c1bf60941d9510ebc20627ca01f05e0eaa53a744bc4877b064deb30c970a7ddfa84fbb0000000002e2b27bcfbccf8db4c82186429b2dd779eca2818b308b88788106bb714bdc99b3';
        const decodedBlock1 = parseSilentBlock(hexStringToBuffer(silentBlock1));
        console.log("decodedBlock => ", decodedBlock1);

    });
});
