import { UTXO, WalletHelper, AddressType } from '@e2e/helpers/wallet.helper';
import { transactionToEntity } from '@e2e/helpers/common.helper';
import { initialiseDep } from '@e2e/setup';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';

describe('Indexer', () => {
    let apiHelper: ApiHelper;
    let walletHelper: WalletHelper;
    let shutdownDep: () => Promise<void>;

    beforeAll(async () => {
        shutdownDep = await initialiseDep();
        walletHelper = new WalletHelper();
        apiHelper = new ApiHelper();

        await walletHelper.initializeWallet();
    });

    afterAll(async () => {
        await shutdownDep();
    });

    const addressTypes: AddressType[] = [
        AddressType.P2WPKH,
        AddressType.P2TR,
        AddressType.P2PKH,
        AddressType.P2SH_P2WPKH,
    ];

    it.each(addressTypes)(
        '%s - should ensure that the correct silent block is fetched',
        async (addressType) => {
            const taprootOutput = walletHelper.generateAddresses(
                1,
                AddressType.P2TR,
            )[0];
            const outputs = walletHelper.generateAddresses(6, addressType);
            const utxos: UTXO[] = [];

            for (const [index, output] of outputs.entries()) {
                const utxo = await walletHelper.addFundToUTXO(
                    output,
                    1,
                    addressType,
                    index,
                );
                utxos.push(utxo);
            }

            const { transaction, txid, blockhash } =
                await walletHelper.craftAndSendTransaction(
                    utxos,
                    taprootOutput,
                    5.999,
                    0.001,
                );

            const blockCount = await walletHelper.getBlockCount();
            const transformedTransaction = transactionToEntity(
                transaction,
                txid,
                blockhash,
                blockCount,
                outputs,
            );

            const silentBlock = new SilentBlocksService(
                {} as any,
                {} as any,
            ).encodeSilentBlock([transformedTransaction]);

            await new Promise((resolve) => setTimeout(resolve, 15000));
            const response = await apiHelper.get(
                `/silent-block/hash/${blockhash}`,
                {
                    responseType: 'arraybuffer',
                },
            );

            expect(response.data).toEqual(silentBlock);
        },
    );
});
