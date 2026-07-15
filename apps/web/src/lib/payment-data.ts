import "server-only";

import type postgres from "postgres";

import { sql } from "./db";

export type CustomerPaymentIdentity = {
  customer_id: string;
  email: string;
  stripe_customer_id: string | null;
};

async function withCustomerActor<T>(
  customerId: string,
  callback: (transaction: postgres.TransactionSql) => Promise<T>,
) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    return callback(transaction);
  });
}

export async function getCustomerPaymentIdentity(customerId: string) {
  return withCustomerActor(customerId, async (transaction) => {
    const rows = await transaction<CustomerPaymentIdentity[]>`
      select * from private.current_customer_payment_identity()`;
    if (rows[0]?.customer_id !== customerId) {
      throw new Error("Customer payment identity is unavailable");
    }
    return rows[0];
  });
}

export async function bindCustomerStripeCustomerId(
  customerId: string,
  stripeCustomerId: string,
) {
  return withCustomerActor(customerId, async (transaction) => {
    const rows = await transaction<{ bound: boolean }[]>`
      select private.bind_current_customer_stripe_customer_id(
        ${stripeCustomerId}
      ) as bound`;
    if (!rows[0]?.bound) {
      throw new Error("Stripe customer identity could not be bound");
    }
  });
}
