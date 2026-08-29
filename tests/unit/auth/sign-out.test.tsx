/**
 * Sign-out tests.
 *
 * Tests the UserMenu component's handleSignOut behavior covering:
 *   - Sign-out uses POST method
 *   - Sign-out sends credentials: 'include'
 *   - Sign-out sends Content-Type: application/json header
 *   - Sign-out sends body '{}'
 *   - After sign-out, redirects to /login
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UserMenu from '@components/layout/UserMenu';

describe('UserMenu — sign out', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    // Mock window.location
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: '/' },
    });
  });

  it('renders the user name', () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('shows sign out button when menu is opened', async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    const menuButton = screen.getByLabelText('Account menu');
    fireEvent.click(menuButton);

    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  it('sends correct fetch call on sign out', async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    // Open menu
    const menuButton = screen.getByLabelText('Account menu');
    fireEvent.click(menuButton);

    // Click sign out
    const signOutButton = screen.getByText('Sign out');
    fireEvent.click(signOutButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/auth/sign-out',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
    });
  });

  it('uses method POST', async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
    });
  });

  it('uses credentials: include', async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      const [, options] = mockFetch.mock.calls[0];
      expect(options.credentials).toBe('include');
    });
  });

  it('sends Content-Type: application/json header', async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Content-Type']).toBe('application/json');
    });
  });

  it("sends body '{}' (not empty)", async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      const [, options] = mockFetch.mock.calls[0];
      expect(options.body).toBe('{}');
    });
  });

  it('redirects to /login after sign-out', async () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      expect(window.location.href).toBe('/login');
    });
  });

  it('shows "Signing out..." while signing out', async () => {
    // Make fetch hang so we can check the intermediate state
    mockFetch.mockImplementation(() => new Promise(() => {}));

    render(<UserMenu name="Test User" email="test@example.com" role="user" />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => {
      expect(screen.getByText('Signing out...')).toBeInTheDocument();
    });
  });

  it('hides Help Center + Chat with us when support is disabled (default)', () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" />);
    fireEvent.click(screen.getByLabelText('Account menu'));
    expect(screen.queryByText('Help Center')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat with us')).not.toBeInTheDocument();
  });

  it('shows Help Center + Chat with us when supportEnabled', () => {
    render(<UserMenu name="Test User" email="test@example.com" role="user" supportEnabled />);
    fireEvent.click(screen.getByLabelText('Account menu'));
    expect(screen.getByText('Help Center')).toBeInTheDocument();
    expect(screen.getByText('Chat with us')).toBeInTheDocument();
  });
});
