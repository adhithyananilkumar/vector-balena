import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImageTickets } from './imageTickets';

describe('ImageTickets', () => {
  it('keeps the config in memory, signs short-lived links and expires old tickets', () => {
    let clock = 1_000_000;
    const tickets = new ImageTickets({ secret: 'secret', now: () => clock });
    const ticket = tickets.create({ marker: 'fleet-a' }, 'generic-amd64', '9.0.4+rev1', 'abc');
    assert.equal(ticket.fileName, 'vector-generic-amd64-9.0.4_rev1.img');
    assert.deepEqual(tickets.get(ticket.id)?.config, { marker: 'fleet-a' });
    assert.equal(tickets.get(ticket.id)?.deviceUuid, 'abc');

    const { expires, signature } = tickets.sign(ticket.id);
    assert.ok(tickets.verify(ticket.id, expires, signature));
    assert.ok(!tickets.verify('0'.repeat(32), expires, signature), 'link is bound to its image');
    assert.ok(!tickets.verify(ticket.id, expires, signature.replace(/.$/, signature.endsWith('0') ? '1' : '0')));
    assert.ok(!tickets.verify(ticket.id, expires + 1, signature));
    assert.ok(!tickets.verify(ticket.id, expires, 'nope'));

    clock += 11 * 60 * 1000;
    assert.ok(!tickets.verify(ticket.id, expires, signature), 'link expires');
    assert.ok(tickets.get(ticket.id), 'the image can still be given a new link');
    clock += 30 * 60 * 1000;
    assert.equal(tickets.get(ticket.id), undefined, 'tickets are discarded after the TTL');
  });

  it('gives every ticket its own id', () => {
    const tickets = new ImageTickets({ secret: 's' });
    assert.notEqual(tickets.create({}, 'a', '1').id, tickets.create({}, 'a', '1').id);
  });
});

describe('base image tickets', () => {
  it('carry no config and have their own file name, but sign and expire like the others', () => {
    let clock = 1_000_000;
    const tickets = new ImageTickets({ secret: 'secret', now: () => clock });
    const base = tickets.createBase('raspberrypi4-64', '9.0.3+rev2', 'admin');
    assert.equal(base.kind, 'base');
    assert.equal(base.config, undefined);
    assert.equal(base.fileName, 'balenaOS-raspberrypi4-64-9.0.3_rev2.img');
    assert.equal(base.createdBy, 'admin');
    const { expires, signature } = tickets.sign(base.id);
    assert.ok(tickets.verify(base.id, expires, signature));
    assert.equal(tickets.create({ a: 1 }, 'x', '1').kind, 'configured');
    clock += 31 * 60 * 1000;
    assert.equal(tickets.get(base.id), undefined);
  });
});
