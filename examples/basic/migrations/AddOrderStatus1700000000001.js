// Written once, applied to every tenant. Note what is NOT here: no schema name.
// The runner points each connection's search_path at the tenant, so "orders" resolves per tenant.
module.exports = class AddOrderStatus1700000000001 {
  name = 'AddOrderStatus1700000000001';

  async up(queryRunner) {
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN "status" text NOT NULL DEFAULT 'new'`);
  }

  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "status"`);
  }
};
