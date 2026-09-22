import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReport } from './report.mjs';

test('owner markdown summarizes technical source in Vietnamese', () => {
  const report = {
    audience: 'owner', observed_status: 'NEEDS_FIX', blockers: ['English internal failure detail'], next_step: 'Run an internal repair command',
    next_actor: 'Sol/Lead', local_product_actions: [], local_product_url: null, source_reference: 'packet', report_bytes: null,
    owner_summary: { technical_checks: 'Một kiểm tra chưa đạt.', independent_review: 'Đánh giá yêu cầu sửa.', product_check: 'Chưa kiểm tra sản phẩm.' },
    truncation: { applied: false, omitted_items: 0, source_reference: 'packet' }
  };
  const output = formatReport(report, { format: 'md' });
  assert.equal(output.includes('English internal failure detail'), false);
  assert.equal(output.includes('Run an internal repair command'), false);
  assert.match(output, /Có 1 trở ngại/);
  assert.match(output, /Sol\/Lead cần xử lý/);
});
