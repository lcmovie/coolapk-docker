import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../utils/runtime', () => ({ apiRequest: api.request }));
import WebAccessGate from '../WebAccessGate.vue';

describe('WebAccessGate', () => {
  beforeEach(() => api.request.mockReset());
  it('validates first-use confirmation before creating durable access configuration', async () => {
    const ready = vi.fn();
    const wrapper = mount(WebAccessGate, { props: { configured: false, onReady: ready } });
    await wrapper.find('#access-password').setValue('test-only-password');
    await wrapper.find('#access-confirm').setValue('different');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.text()).toContain('两次输入的密码不一致');
    expect(api.request).not.toHaveBeenCalled();
    api.request.mockResolvedValue({ authenticated: true });
    await wrapper.find('#access-confirm').setValue('test-only-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.request).toHaveBeenCalledWith('/api/auth/setup', expect.objectContaining({ method: 'POST' }));
    expect(ready).toHaveBeenCalledOnce();
    expect((wrapper.find('#access-password').element as HTMLInputElement).value).toBe('');
  });

  it('shows an incorrect password error and allows another login attempt', async () => {
    const ready = vi.fn();
    const wrapper = mount(WebAccessGate, { props: { configured: true, onReady: ready } });
    api.request.mockRejectedValueOnce(new Error('密码错误'));
    await wrapper.find('#access-password').setValue('wrong-test-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe('密码错误');
    expect(ready).not.toHaveBeenCalled();
    api.request.mockResolvedValueOnce({ authenticated: true });
    await wrapper.find('#access-password').setValue('correct-test-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.request).toHaveBeenLastCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
    expect(ready).toHaveBeenCalledOnce();
  });
});
