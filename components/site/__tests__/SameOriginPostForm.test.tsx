import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SameOriginPostForm from '../SameOriginPostForm';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failOnce(alertBeforeButton: boolean) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
  const { container } = render(
    <SameOriginPostForm action="/api/curation/login" submitLabel="Sign in" alertBeforeButton={alertBeforeButton}>
      <input aria-label="Passphrase" name="passphrase" defaultValue="x" />
      <p data-testid="refusal">That didn&apos;t sign you in.</p>
    </SameOriginPostForm>,
  );
  const button = screen.getByRole('button', { name: 'Sign in' });
  await vi.waitFor(() => expect(button).toBeEnabled());
  fireEvent.submit(container.querySelector('form')!);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("That didn't go through. Reload the page and try again.");
  return { alert, button, refusal: screen.getByTestId('refusal') };
}

describe('SameOriginPostForm', () => {
  it('marks the form settled once the button is enabled, so its first enable never fades', async () => {
    const { container } = render(<SameOriginPostForm action="/api/curation/login" submitLabel="Sign in" />);
    const button = screen.getByRole('button', { name: 'Sign in' });
    await vi.waitFor(() => expect(button).toBeEnabled());
    expect(container.querySelector('form')).toHaveAttribute('data-settled', 'true');
  });

  it('keeps the button focusable while the post is on its way, says it is unavailable, and posts once', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<SameOriginPostForm action="/api/curation/login" submitLabel="Sign in" pendingLabel="Signing in…" />);
    const button = screen.getByRole('button', { name: 'Sign in' });
    await vi.waitFor(() => expect(button).toBeEnabled());
    button.focus();
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    // aria-disabled, not disabled: a focused button that turns disabled drops focus to the page's body.
    await vi.waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent('Signing in…');
    expect(form).toHaveAttribute('aria-busy', 'true');
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    answer(new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
  });

  it("puts the line that says a post didn't go through under the fields, ahead of the button, when asked", async () => {
    const { alert, button, refusal } = await failOnce(true);
    // After the server's refusal and the field, before the button: one home for every refusal.
    expect(refusal.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps that line after the button otherwise, as Sign out has it', async () => {
    const { alert, button } = await failOnce(false);
    expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
