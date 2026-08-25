import { describe, expect, it } from 'vitest';

import { OUTWARD_TEMPLATES, renderSignedHtml, type SignatureLogo } from './mail-signature';

/**
 * The letterhead on an outgoing rate request.
 *
 * Two properties carry the weight here. The HTML part must say the same thing
 * as the plain-text part it was built from — a message whose two halves differ
 * is a message nobody can be held to. And a body must not be able to smuggle
 * markup into it: an inquiry's remarks reach this after a user typed them.
 */

const logo = (over: Partial<SignatureLogo> = {}): SignatureLogo => ({
  cid: 'sig-1@ff-erp',
  altText: 'BAFFA member',
  heightPx: 30,
  content: Buffer.from('not really a png'),
  fileName: 'baffa.png',
  ...over,
});

describe('the signed HTML part', () => {
  it('says what the text part says', () => {
    const text = ['Dear Sir/Madam,', '', 'Commodity: Knitted garments', 'POL: Chattogram'].join(
      '\n',
    );
    const html = renderSignedHtml(text, []);
    for (const line of ['Dear Sir/Madam,', 'Commodity: Knitted garments', 'POL: Chattogram']) {
      expect(html).toContain(line);
    }
  });

  it('keeps the blank lines that separate the paragraphs', () => {
    const html = renderSignedHtml('one\n\ntwo', []);
    // Without this the letter arrives as one run-on block.
    expect(html).toContain('one<br>');
    expect(html).toContain('<br>');
    expect(html.indexOf('one')).toBeLessThan(html.indexOf('two'));
  });

  it('refuses to carry markup out of the body', () => {
    /*
     * The remarks on an inquiry are typed by a person and end up in this body.
     * Anything that looked like a tag has to arrive as text, or a rate request
     * becomes a way to post script into someone's mail client.
     */
    const html = renderSignedHtml('<script>alert(1)</script> & "quoted"', []);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('references each logo by cid, never by a URL', () => {
    // A hosted image is blocked by default in the clients that matter, so a
    // src that is not a cid is a broken box at the recipient's end.
    const html = renderSignedHtml('body', [
      logo({ cid: 'sig-1@ff-erp' }),
      logo({ cid: 'sig-2@ff-erp', altText: 'DP Alliance' }),
    ]);
    expect(html).toContain('src="cid:sig-1@ff-erp"');
    expect(html).toContain('src="cid:sig-2@ff-erp"');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('src="data:');
  });

  it('gives every logo alt text', () => {
    // A blocked image with no alt text is a blank space where a credential was.
    const html = renderSignedHtml('body', [logo()]);
    expect(html).toContain('alt="BAFFA member"');
  });

  it('escapes the alt text too', () => {
    const html = renderSignedHtml('body', [logo({ altText: 'A "B" & <C>' })]);
    expect(html).toContain('&quot;B&quot;');
    expect(html).not.toContain('<C>');
  });

  it('sets a height on each, so a row of logos lines up', () => {
    const html = renderSignedHtml('body', [logo({ heightPx: 44 })]);
    expect(html).toContain('height="44"');
    expect(html).toContain('height:44px');
  });

  it('adds nothing when there are no logos', () => {
    const html = renderSignedHtml('body', []);
    expect(html).not.toContain('<img');
  });
});

describe('which letters carry a letterhead', () => {
  it('the ones that leave the building', () => {
    expect(OUTWARD_TEMPLATES.has('INQUIRY_AGENT_RFQ')).toBe(true);
    expect(OUTWARD_TEMPLATES.has('INQUIRY_CARRIER_RFQ')).toBe(true);
  });

  it('not the note between colleagues', () => {
    // The price-team alert is internal. A letterhead on it would be odd, and
    // deciding by string-matching the body would break the first time somebody
    // edited their template.
    expect(OUTWARD_TEMPLATES.has('INQUIRY_PRICE_TEAM')).toBe(false);
    expect(OUTWARD_TEMPLATES.has('AGENT_QUOTE_SUBMITTED')).toBe(false);
  });
});
