/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Counter mode / pay-first ("Pay & send"), end to end against a REAL,
// migrated + seeded Postgres. Opt-in:
//   COUNTER_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json counter-mode
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.COUNTER_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);

run('Counter mode: pay-first orders (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let burger: string;
  let fries: string;

  const post = (p: string, b?: object) => owner.post(`/api/v1${p}`).send(b);
  const get = (p: string) => owner.get(`/api/v1${p}`);

  const order = async (hold: boolean, items?: object[]) => {
    const res = await post(`/orders${q}`, {
      type: 'TAKEAWAY',
      holdKitchenUntilPaid: hold,
      items: items ?? [{ menuItemId: burger, quantity: 2, modifierIds: [] }],
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body as { id: string; totalAmount: string };
  };
  const detail = async (id: string) =>
    (await get(`/orders/${id}${q}`).expect(200)).body as {
      status: string;
      kitchenHeldUntilPaid: boolean;
      kots: { id: string; items: unknown[] }[];
    };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();

    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);

    const cats = (await get(`/menu/categories${q}`).expect(200)).body;
    const mk = async (name: string) =>
      (
        await post(`/menu/items${q}`, {
          categoryId: cats[0].id,
          name: `${name}-${tag}`,
          price: 100,
          taxRatePercent: 0,
        }).expect(201)
      ).body.id as string;
    burger = await mk('Burger');
    fries = await mk('Fries');
  });

  afterAll(async () => {
    await app.close();
  });

  it('saves the branch counter-mode setting', async () => {
    await owner
      .patch(`/api/v1/settings/branch${q}`)
      .send({ counterMode: true })
      .expect(200);
    const s = (await get(`/settings${q}`).expect(200)).body;
    expect(s.branch.counterMode).toBe(true);
    await owner
      .patch(`/api/v1/settings/branch${q}`)
      .send({ counterMode: false })
      .expect(200);
  });

  it('a normal order still reaches the kitchen straight away', async () => {
    const o = await order(false);
    const d = await detail(o.id);
    expect(d.kitchenHeldUntilPaid).toBe(false);
    expect(d.kots.length).toBe(1);
  });

  it('a pay-first order has no kitchen ticket until it is paid', async () => {
    const o = await order(true);
    const before = await detail(o.id);
    expect(before.status).toBe('OPEN');
    expect(before.kitchenHeldUntilPaid).toBe(true);
    expect(before.kots).toHaveLength(0);

    const paid = await post(`/orders/${o.id}/checkout${q}`, {
      payments: [{ method: 'CASH', amount: 500 }],
    });
    expect(paid.status).toBe(201);
    expect(paid.body.settlement.fullyPaid).toBe(true);
    expect(paid.body.settlement.changeDue).toBe(300);

    const after = await detail(o.id);
    expect(after.status).toBe('PAID');
    expect(after.kitchenHeldUntilPaid).toBe(false);
    expect(after.kots).toHaveLength(1);
    expect(after.kots[0].items).toHaveLength(1);
  });

  it('a part payment does not fire the kitchen; the final one does', async () => {
    const o = await order(true);
    await post(`/orders/${o.id}/checkout${q}`, {
      payments: [{ method: 'CASH', amount: 50 }],
      allowPartial: true,
    }).expect(201);
    expect((await detail(o.id)).kots).toHaveLength(0);

    await post(`/orders/${o.id}/checkout${q}`, {
      payments: [{ method: 'UPI', amount: 150 }],
    }).expect(201);
    const d = await detail(o.id);
    expect(d.status).toBe('PAID');
    expect(d.kots).toHaveLength(1);
  });

  it('items added before payment go to the kitchen with the rest', async () => {
    const o = await order(true);
    await post(`/orders/${o.id}/items${q}`, {
      items: [{ menuItemId: fries, quantity: 1, modifierIds: [] }],
    }).expect(201);
    expect((await detail(o.id)).kots).toHaveLength(0);

    await post(`/orders/${o.id}/checkout${q}`, {
      payments: [{ method: 'CASH', amount: 300 }],
    }).expect(201);
    const d = await detail(o.id);
    const lines = d.kots.reduce((n, k) => n + k.items.length, 0);
    expect(lines).toBe(2);
  });

  it('can be sent to the kitchen unpaid, once', async () => {
    const o = await order(true);
    await post(`/orders/${o.id}/send-to-kitchen${q}`).expect(201);
    const d = await detail(o.id);
    expect(d.status).toBe('OPEN');
    expect(d.kitchenHeldUntilPaid).toBe(false);
    expect(d.kots).toHaveLength(1);

    // Second tap: refused, no duplicate ticket.
    await post(`/orders/${o.id}/send-to-kitchen${q}`).expect(409);
    // Paying afterwards does not fire a second ticket.
    await post(`/orders/${o.id}/checkout${q}`, {
      payments: [{ method: 'CASH', amount: 200 }],
    }).expect(201);
    expect((await detail(o.id)).kots).toHaveLength(1);
  });

  it('refuses to merge a held order with one already in the kitchen', async () => {
    const held = await order(true);
    const live = await order(false);
    const res = await post(`/orders/${live.id}/merge${q}`, {
      sourceOrderId: held.id,
    });
    expect(res.status).toBe(400);
  });

  it('a cancelled held order never reaches the kitchen', async () => {
    const o = await order(true);
    await post(`/orders/${o.id}/cancel${q}`, {
      reason: 'Customer left',
    }).expect(201);
    const d = await detail(o.id);
    expect(d.status).toBe('CANCELLED');
    expect(d.kots).toHaveLength(0);
  });
});
