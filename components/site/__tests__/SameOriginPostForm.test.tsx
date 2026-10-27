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
