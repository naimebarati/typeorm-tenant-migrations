import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table } from 'typeorm';

/** Raw SQL with NO schema qualification: the case that `schema` alone gets wrong. */
export class AddOrderStatus1700000000001 implements MigrationInterface {
  name = 'AddOrderStatus1700000000001';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE "orders" ADD COLUMN "status" text');
  }
  async down(q: QueryRunner) {
    await q.query('ALTER TABLE "orders" DROP COLUMN "status"');
  }
}

/** Same intent through the QueryRunner schema API. */
export class CreateThings1700000000002 implements MigrationInterface {
  name = 'CreateThings1700000000002';
  async up(q: QueryRunner) {
    await q.createTable(new Table({ name: 'things', columns: [{ name: 'id', type: 'int', isPrimary: true }] }));
  }
  async down(q: QueryRunner) {
    await q.dropTable('things');
  }
}

export class AddOrderNote1700000000003 implements MigrationInterface {
  name = 'AddOrderNote1700000000003';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE "orders" ADD COLUMN "note" text');
  }
  async down() {}
}

export const goodMigrations = [AddOrderStatus1700000000001, CreateThings1700000000002, AddOrderNote1700000000003];

/** Fails after doing real work, to show what a transaction rolls back. */
export class FailsAfterWork1700000000004 implements MigrationInterface {
  name = 'FailsAfterWork1700000000004';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE "orders" ADD COLUMN "half_done" text');
    throw new Error('boom: intentional test failure');
  }
  async down() {}
}

/** Build a migration whose class name carries a timestamp, from just a body. */
export function defineMigration(name: string, up: (q: QueryRunner) => Promise<void>, options: { transaction?: boolean } = {}): new () => MigrationInterface {
  return class implements MigrationInterface {
    name = name;
    transaction = options.transaction;
    up = up;
    async down() {}
  };
}
