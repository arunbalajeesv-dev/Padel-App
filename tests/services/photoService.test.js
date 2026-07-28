import { describe, it, expect, vi, beforeEach } from 'vitest';

const save = vi.fn();
const publicUrl = vi.fn(() => 'https://storage.googleapis.com/bucket/users/uid-1/profile.jpg');
const deleteFile = vi.fn().mockResolvedValue(undefined);
const file = vi.fn(() => ({ save, publicUrl, delete: deleteFile }));
const getStorage = vi.fn(() => ({ file }));

vi.mock('../../src/config/firebase.js', () => ({ getStorage }));

const { validatePhoto, uploadProfilePhoto, deleteProfilePhoto } = await import(
  '../../src/services/photoService.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  publicUrl.mockReturnValue('https://storage.googleapis.com/bucket/users/uid-1/profile.jpg');
  deleteFile.mockResolvedValue(undefined);
});

describe('validatePhoto', () => {
  it('accepts a well-formed jpeg', () => {
    expect(validatePhoto({ mimetype: 'image/jpeg', size: 1024 })).toEqual([]);
  });

  it.each(['image/png', 'image/webp'])('accepts %s too', (mimetype) => {
    expect(validatePhoto({ mimetype, size: 1024 })).toEqual([]);
  });

  it('requires a file at all', () => {
    expect(validatePhoto(undefined)).toEqual(['A photo file is required.']);
  });

  it('rejects an unsupported type', () => {
    const errors = validatePhoto({ mimetype: 'image/gif', size: 1024 });
    expect(errors).toContain('Photo must be a JPEG, PNG, or WebP image.');
  });

  it('rejects a file over 5MB', () => {
    const errors = validatePhoto({ mimetype: 'image/jpeg', size: 6 * 1024 * 1024 });
    expect(errors).toContain('Photo must be 5MB or smaller.');
  });

  it('accepts exactly 5MB', () => {
    expect(validatePhoto({ mimetype: 'image/jpeg', size: 5 * 1024 * 1024 })).toEqual([]);
  });
});

describe('uploadProfilePhoto', () => {
  it('writes to a fixed per-user path derived from the mimetype extension', async () => {
    await uploadProfilePhoto('uid-1', { buffer: Buffer.from('x'), mimetype: 'image/png' });

    expect(file).toHaveBeenCalledWith('users/uid-1/profile.png');
  });

  it('uploads the buffer as PUBLIC, with the content type set', async () => {
    const buffer = Buffer.from('image-bytes');
    await uploadProfilePhoto('uid-1', { buffer, mimetype: 'image/jpeg' });

    expect(save).toHaveBeenCalledWith(
      buffer,
      expect.objectContaining({ contentType: 'image/jpeg', public: true }),
    );
  });

  it('returns the public URL', async () => {
    const url = await uploadProfilePhoto('uid-1', { buffer: Buffer.from('x'), mimetype: 'image/jpeg' });
    expect(url).toBe('https://storage.googleapis.com/bucket/users/uid-1/profile.jpg');
  });

  it('re-uploading the SAME uid and type overwrites rather than accumulating', async () => {
    await uploadProfilePhoto('uid-1', { buffer: Buffer.from('a'), mimetype: 'image/jpeg' });
    await uploadProfilePhoto('uid-1', { buffer: Buffer.from('b'), mimetype: 'image/jpeg' });

    expect(file).toHaveBeenNthCalledWith(1, 'users/uid-1/profile.jpg');
    expect(file).toHaveBeenNthCalledWith(2, 'users/uid-1/profile.jpg');
  });
});

describe('deleteProfilePhoto', () => {
  it('tries every extension uploadProfilePhoto can produce, since none is tracked separately', async () => {
    await deleteProfilePhoto('uid-1');

    const paths = file.mock.calls.map((call) => call[0]);
    expect(paths.sort()).toEqual(
      ['users/uid-1/profile.jpg', 'users/uid-1/profile.png', 'users/uid-1/profile.webp'].sort(),
    );
    expect(deleteFile).toHaveBeenCalledTimes(3);
  });

  it('treats a missing file (404) as success, not an error', async () => {
    deleteFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

    await expect(deleteProfilePhoto('uid-1')).resolves.toBeUndefined();
  });

  it('still throws on a real failure, e.g. a permissions error', async () => {
    deleteFile.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 403 }));

    await expect(deleteProfilePhoto('uid-1')).rejects.toThrow('permission denied');
  });
});
