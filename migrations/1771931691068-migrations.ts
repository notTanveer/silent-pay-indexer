import { MigrationInterface, QueryRunner } from 'typeorm';

export class Migrations1771931691068 implements MigrationInterface {
    name = 'Migrations1771931691068';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE INDEX "IDX_transaction_blockHeight" ON "transaction" ("blockHeight")`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_transaction_output_isSpent" ON "transaction_output" ("isSpent")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_transaction_output_isSpent"`);
        await queryRunner.query(`DROP INDEX "IDX_transaction_blockHeight"`);
    }
}
