// ============================================================
// History list rendering (renderer/history.js) — deposit column
// ============================================================
// Pure markup helpers behind the history modal: the deposit ("señal")
// cell (chip when paid / "Marcar señal" button / disabled for a
// pending id) and the inline amount form. No DOM, no IPC.
// ============================================================
import { describe, test, expect } from 'vitest';
import { renderHistoryList, renderDepositCell, renderDepositForm } from '../renderer/history.js';

const BASE = {
  id: 'PP-2026-0001', date: '2026-09-01T10:00:00.000Z', user: 'Ana',
  customer: { name: 'Peña' }, pack_id: 'crew', total_vat_inc: 300, status: 'pending'
};
const AT = '2026-09-04T10:00:00.000Z';

describe('renderDepositCell', () => {
  test('unpaid: a "Marcar señal" button carrying the row id', () => {
    const html = renderDepositCell(BASE);
    expect(html).toContain('data-action="deposit-mark"');
    expect(html).toContain('data-id="PP-2026-0001"');
    expect(html).toContain('Marcar señal');
    expect(html).not.toContain('disabled');
  });

  test('paid: a success chip with the amount; date + user in the title; clears on click', () => {
    const html = renderDepositCell({ ...BASE, status: 'accepted', deposit_paid: { amount: 121.5, at: AT, by: 'Mostrador' } });
    expect(html).toContain('quote-chip--deposit');
    expect(html).toContain('Señal · 121,50 €');
    expect(html).toContain('data-action="deposit-clear"');
    expect(html).toContain('04/09/2026');
    expect(html).toContain('por Mostrador');
  });

  test('pending (PP-PENDING-…): the button is disabled with the sync reason', () => {
    const html = renderDepositCell({ ...BASE, id: 'PP-PENDING-abc' });
    expect(html).toContain('disabled');
    expect(html).toMatch(/sincronice/);
  });

  test('escapes the user name (XSS)', () => {
    const html = renderDepositCell({ ...BASE, deposit_paid: { amount: 1, at: AT, by: '<img onerror=x>' } });
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;img');
  });

  test('a null deposit_paid renders the unpaid button', () => {
    expect(renderDepositCell({ ...BASE, deposit_paid: null })).toContain('data-action="deposit-mark"');
  });
});

describe('renderDepositForm', () => {
  test('prefills the amount with two decimals and a comma, with confirm + cancel controls', () => {
    const html = renderDepositForm('PP-2026-0001', 494);
    expect(html).toContain('value="494,00"');
    expect(html).toContain('data-deposit-form="PP-2026-0001"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-deposit-cancel');
  });

  test('escapes the id', () => {
    const html = renderDepositForm('"><script>x</script>', 1);
    expect(html).not.toContain('<script>');
  });
});

describe('renderHistoryList — deposit column', () => {
  test('adds a "Señal" header and one deposit cell per row', () => {
    const html = renderHistoryList([
      BASE,
      { ...BASE, id: 'PP-2026-0002', deposit_paid: { amount: 50, at: AT, by: null } }
    ]);
    expect(html).toContain('<th>Señal</th>');
    expect((html.match(/data-action="deposit-mark"/g) || []).length).toBe(1);
    expect((html.match(/data-action="deposit-clear"/g) || []).length).toBe(1);
  });
});
