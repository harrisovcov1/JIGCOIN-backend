'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createGameplay} = require('../lib/gameplay');

const start = new Date('2026-11-19T10:00:00.000Z');
const at = milliseconds => new Date(start.getTime() + milliseconds);
const gameplay = createGameplay({getEnergyCap: user => user.max_energy});
const account = energy => ({energy, max_energy:55, last_energy_ts:start, last_reset:'2026-11-19'});

test('state and tap use identical refill bands and retain partial elapsed time', () => {
  const user = account(8);
  for (const [elapsed, energy, carry] of [[999,8,999], [1000,9,0], [1900,9,900],
      [2000,10,0], [4999,10,2999], [5000,11,0], [62000,30,0], [67999,30,5999], [68000,31,0]]) {
    const frame = gameplay.clientEnergy(user, at(elapsed));
    assert.equal(frame.energy, energy);
    assert.equal(frame.energy_clock.elapsed_ms, carry);
    assert.equal(gameplay.project(user, at(elapsed)).energy, energy);
  }
  assert.deepEqual(gameplay.clientEnergy(user, start).energy_clock.bands, [
    {below:10, ms:1000}, {below:30, ms:3000}, {below:null, ms:6000}
  ]);
});
test('processing another receipt or state read preserves fraction across a refill', () => {
  const user = gameplay.project(account(16), at(2900));
  const spent = {...user,energy:user.energy - 2};
  assert.equal(gameplay.clientEnergy(spent, at(2999)).energy,14);
  assert.equal(gameplay.clientEnergy(spent, at(3000)).energy,15);
  assert.equal(gameplay.clientEnergy(spent, at(3250)).energy_clock.elapsed_ms,250);
});
test('full capacity accrues no banked ticks and UTC day reset yields a full bar', () => {
  const full = gameplay.project(account(55), at(24000));
  const spent = {...full, energy:54};
  assert.equal(gameplay.clientEnergy(spent, at(29999)).energy,54);
  assert.equal(gameplay.clientEnergy(spent, at(30000)).energy,55);
  assert.equal(gameplay.clientEnergy(account(0),new Date('2026-11-20T00:00:00Z')).energy,55);
});
