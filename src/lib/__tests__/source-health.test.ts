import {
  applyHealthReport,
  HealthFields,
  ProbeFetch,
  probeVideoSource,
  shouldProbe,
  shouldSuppressDisabling,
} from '@/lib/source-health';

describe('健康状态机', () => {
  it('首次失败只累计计数，不立刻停用', () => {
    const item: HealthFields = {};

    applyHealthReport(item, { ok: false, error: 'HTTP 500' });

    expect(item.failCount).toBe(1);
    expect(item.disabled).toBeUndefined();
    expect(item.disabledBy).toBeUndefined();
    expect(item.lastCheckError).toBe('HTTP 500');
    expect(typeof item.lastCheckAt).toBe('string');
  });

  it('连续两次失败后自动停用', () => {
    const item: HealthFields = {};

    applyHealthReport(item, { ok: false, error: '第一个错误' });
    applyHealthReport(item, { ok: false, error: '第二个错误' });

    expect(item.failCount).toBe(2);
    expect(item.disabled).toBe(true);
    expect(item.disabledBy).toBe('auto');
  });

  it('失败后成功一次就清零失败计数', () => {
    const item: HealthFields = {};

    applyHealthReport(item, { ok: false, error: '一次抖动' });
    applyHealthReport(item, { ok: true });

    expect(item.failCount).toBe(0);
    expect(item.disabled).toBeUndefined();
    expect(item.lastCheckError).toBeUndefined();
  });

  it('自动停用后需要连续两次成功才恢复', () => {
    const item: HealthFields = {};
    applyHealthReport(item, { ok: false, error: '挂了' });
    applyHealthReport(item, { ok: false, error: '还是挂了' });

    applyHealthReport(item, { ok: true });
    expect(item.disabled).toBe(true);
    expect(item.successCount).toBe(1);

    applyHealthReport(item, { ok: true });
    expect(item.disabled).toBe(false);
    expect(item.disabledBy).toBeUndefined();
    expect(item.successCount).toBe(0);
  });

  it('恢复过程中再次失败会打断恢复计数', () => {
    const item: HealthFields = {};
    applyHealthReport(item, { ok: false, error: '挂了' });
    applyHealthReport(item, { ok: false, error: '还是挂了' });
    applyHealthReport(item, { ok: true });

    applyHealthReport(item, { ok: false, error: '又挂了' });

    expect(item.successCount).toBe(0);
    expect(item.disabled).toBe(true);
    expect(item.lastCheckError).toBe('又挂了');
  });

  it('老配置里没有 disabledBy 的 disabled 视为手动停用', () => {
    expect(shouldProbe({ disabled: true })).toBe(false);
    expect(shouldProbe({ disabled: true, disabledBy: 'manual' })).toBe(false);
    expect(shouldProbe({ disabled: true, disabledBy: 'auto' })).toBe(true);
    expect(shouldProbe({ disabled: false })).toBe(true);
    expect(shouldProbe({})).toBe(true);
  });

  it('手动停用的源即使被检测也不改状态', () => {
    const item: HealthFields = { disabled: true, disabledBy: 'manual' };

    applyHealthReport(item, { ok: true });
    applyHealthReport(item, { ok: false, error: '挂了' });

    expect(item.disabled).toBe(true);
    expect(item.disabledBy).toBe('manual');
    expect(item.successCount).toBeUndefined();
    expect(item.failCount).toBeUndefined();
  });
});

describe('熔断保护', () => {
  it('大面积同时失败时不落停用', () => {
    expect(shouldSuppressDisabling(8, 10)).toBe(true);
  });

  it('少数源失败时正常执行停用', () => {
    expect(shouldSuppressDisabling(2, 10)).toBe(false);
  });

  it('源太少时不熔断，否则小站永远停不掉坏源', () => {
    expect(shouldSuppressDisabling(3, 3)).toBe(false);
  });
});

describe('视频源探活', () => {
  const jsonResponse = (payload: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => payload } as unknown as Response);

  it('返回合法 JSON 且带 list 字段视为健康（list 为空也算）', async () => {
    let requestedUrl = '';
    const fetchImpl: ProbeFetch = async (input) => {
      requestedUrl = input;
      return jsonResponse({ list: [] });
    };

    const report = await probeVideoSource('https://a.example/api.php', {
      fetchImpl,
    });

    expect(report).toEqual({ ok: true });
    expect(requestedUrl).toContain('ac=videolist');
    expect(requestedUrl).toContain('wd=');
  });

  it('缺少 list 字段视为失败', async () => {
    const report = await probeVideoSource('https://a.example/api.php', {
      fetchImpl: async () => jsonResponse({ code: 0, msg: 'no data' }),
    });

    expect(report.ok).toBe(false);
    expect(report).toHaveProperty('error');
  });

  it('HTTP 状态码非 2xx 视为失败', async () => {
    const report = await probeVideoSource('https://a.example/api.php', {
      fetchImpl: async () => jsonResponse({}, false, 500),
    });

    expect(report.ok).toBe(false);
    expect(report).toHaveProperty('error', expect.stringContaining('500'));
  });

  it('返回内容不是合法 JSON 视为失败', async () => {
    const report = await probeVideoSource('https://a.example/api.php', {
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        } as unknown as Response),
    });

    expect(report.ok).toBe(false);
    expect(report).toHaveProperty('error', expect.stringContaining('JSON'));
  });

  it('网络异常不抛出，转成失败结果', async () => {
    const report = await probeVideoSource('https://a.example/api.php', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(report.ok).toBe(false);
    expect(report).toHaveProperty(
      'error',
      expect.stringContaining('ECONNREFUSED')
    );
  });
});
