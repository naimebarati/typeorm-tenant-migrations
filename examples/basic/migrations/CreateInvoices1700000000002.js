const { Table } = require('typeorm');

// The QueryRunner schema API also lands in the tenant schema.
module.exports = class CreateInvoices1700000000002 {
  name = 'CreateInvoices1700000000002';

  async up(queryRunner) {
    await queryRunner.createTable(
      new Table({
        name: 'invoices',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'order_id', type: 'int' },
        ],
      }),
    );
    // Touching a shared table is the exception: qualify it explicitly. Under the default
    // search_path ('tenant-only') an unqualified shared name would NOT resolve, by design.
    // await queryRunner.query(`INSERT INTO "shared"."audit_log"(event) VALUES ('invoices created')`);
  }

  async down(queryRunner) {
    await queryRunner.dropTable('invoices');
  }
};
