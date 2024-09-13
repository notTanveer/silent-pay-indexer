import { WalletHelper } from '@e2e/helpers/wallet.helper';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { parseSilentBlock } from '@/common/common';

describe('WalletHelper Integration Tests', () => {
    let walletHelper: WalletHelper;
    let bitcoinRPCUtil: BitcoinRPCUtil;
    let apiHelper: ApiHelper;
    let initialAddress: string;
    let newAddress: string;
    let p2wkhAddresses: string[];
    let taprootAddress: string;
    let utxos: { txid: string, vout: number, value: number, rawTx: string }[];

    beforeAll(async () => {
        walletHelper = new WalletHelper();
        bitcoinRPCUtil = new BitcoinRPCUtil();
        apiHelper = new ApiHelper();

        await bitcoinRPCUtil.createWallet('test_wallet');
        initialAddress = await bitcoinRPCUtil.getNewAddress();

        taprootAddress = walletHelper.generateAddresses(1, 'p2tr')[0];
        p2wkhAddresses = walletHelper.generateAddresses(8, 'p2wpkh');

        await bitcoinRPCUtil.mineToAddress(101, initialAddress);

        for (const address of p2wkhAddresses) {
            await bitcoinRPCUtil.sendToAddress(address, 1);
        }

        newAddress = await bitcoinRPCUtil.getNewAddress();
        await bitcoinRPCUtil.mineToAddress(6, newAddress);

        utxos = [];
        for (let i = 0; i < 6; i++) {
            const txid = await bitcoinRPCUtil.sendToAddress(p2wkhAddresses[i], 1);
            for (let vout = 0; vout < 2; vout++) {
                const utxo = await bitcoinRPCUtil.getTxOut(txid, vout);
                if (utxo && Math.round(utxo.value * 1e8) === 1e8) {
                    utxos.push({
                        txid: txid,
                        vout: vout,
                        value: Math.round(utxo.value * 1e8),
                        rawTx: await bitcoinRPCUtil.getRawTransaction(txid),
                    });
                    break;
                }
            }
        }
    });

    it('should craft and broadcast transactions, then verify them', async () => {
        const rawTx = walletHelper.craftTransaction(
            utxos.slice(0, 5),  
            taprootAddress,      // Send 6 BTC to taproot address with 1 BTC fee
        );
    
        await bitcoinRPCUtil.sendRawTransaction(rawTx);
        await bitcoinRPCUtil.mineToAddress(1, initialAddress);
    
        await new Promise(resolve => setTimeout(resolve, 30000));
    
        const response = await apiHelper.get(`/silent-block/height/108`);
        const silentBlock = response.data;
    
        const decodedBlock = parseSilentBlock(silentBlock);
        const transactions = decodedBlock.transactions;
    
        const foundTx = transactions.find((tx: any) => tx.txid === rawTx);
        expect(foundTx).toBeDefined();
        
        expect(foundTx.vout.length).toBeGreaterThan(0);
        
        const output = foundTx.vout.find((vout: any) => vout.address === taprootAddress);
        expect(output).toBeDefined();
        expect(output.value).toEqual(5 * 1e8);
    });
});