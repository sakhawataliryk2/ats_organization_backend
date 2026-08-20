const axios = require('axios');
const cheerio = require('cheerio');

class ScrapeController {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Scrape lead data from Toponehire.com
     */
    async scrapeToponehire(req, res) {
        try {
            const { url, searchQuery, maxResults = 50 } = req.body;

            console.log(`Scraping Toponehire.com - URL: ${url}, Query: ${searchQuery}, Max Results: ${maxResults}`);

            // Construct the search URL if searchQuery is provided
            let targetUrl = url || 'https://toponehire.com';
            if (searchQuery) {
                // Adjust URL based on Toponehire.com's search structure
                targetUrl = `https://toponehire.com/search?q=${encodeURIComponent(searchQuery)}`;
            }

            // Fetch the page
            const response = await axios.get(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                timeout: 30000
            });

            const $ = cheerio.load(response.data);
            const scrapedLeads = [];

            // Parse the HTML structure - adjust selectors based on Toponehire.com's actual structure
            // Common patterns for job board sites:
            // - Job listings in containers (divs, articles, etc.)
            // - Contact information in specific sections
            // - Company/organization names
            // - Job titles

            // Example selectors (adjust based on actual site structure):
            // Look for job listings, profiles, or contact cards
            $('.job-listing, .profile-card, .contact-card, .candidate-card, article.job, .result-item').each((index, element) => {
                if (scrapedLeads.length >= maxResults) return false; // Stop if we've reached max results

                const $element = $(element);
                
                // Extract lead information
                const lead = {
                    firstName: '',
                    lastName: '',
                    email: '',
                    phone: '',
                    title: '',
                    organization: '',
                    location: '',
                    linkedinUrl: '',
                    source: 'Toponehire.com',
                    rawData: {}
                };

                // Try to extract name (adjust selectors based on actual structure)
                const nameText = $element.find('.name, .candidate-name, .contact-name, h2, h3, .title').first().text().trim();
                if (nameText) {
                    const nameParts = nameText.split(/\s+/);
                    if (nameParts.length >= 2) {
                        lead.firstName = nameParts[0];
                        lead.lastName = nameParts.slice(1).join(' ');
                    } else if (nameParts.length === 1) {
                        lead.firstName = nameParts[0];
                        lead.lastName = '';
                    }
                }

                // Extract email
                const emailText = $element.find('.email, a[href^="mailto:"]').first().text().trim() ||
                    $element.find('a[href^="mailto:"]').attr('href')?.replace('mailto:', '') || '';
                if (emailText) {
                    lead.email = emailText;
                }

                // Extract phone
                const phoneText = $element.find('.phone, .tel, a[href^="tel:"]').first().text().trim() ||
                    $element.find('a[href^="tel:"]').attr('href')?.replace('tel:', '') || '';
                if (phoneText) {
                    lead.phone = phoneText.replace(/[^\d+()-]/g, ''); // Clean phone number
                }

                // Extract job title
                const titleText = $element.find('.job-title, .position, .role, .title').first().text().trim();
                if (titleText) {
                    lead.title = titleText;
                }

                // Extract organization/company
                const orgText = $element.find('.company, .organization, .employer, .client').first().text().trim();
                if (orgText) {
                    lead.organization = orgText;
                }

                // Extract location
                const locationText = $element.find('.location, .city, .address').first().text().trim();
                if (locationText) {
                    lead.location = locationText;
                }

                // Extract LinkedIn URL
                const linkedinLink = $element.find('a[href*="linkedin.com"]').first().attr('href');
                if (linkedinLink) {
                    lead.linkedinUrl = linkedinLink.startsWith('http') ? linkedinLink : `https://${linkedinLink}`;
                }

                // Store raw HTML for debugging
                lead.rawData = {
                    html: $element.html(),
                    text: $element.text()
                };

                // Only add if we have at least a name or email
                if (lead.firstName || lead.email) {
                    scrapedLeads.push(lead);
                }
            });

            // If no results with those selectors, try alternative patterns
            if (scrapedLeads.length === 0) {
                // Try parsing JSON-LD structured data if available
                $('script[type="application/ld+json"]').each((index, element) => {
                    try {
                        const jsonData = JSON.parse($(element).html());
                        if (jsonData['@type'] === 'Person' || jsonData['@type'] === 'JobPosting') {
                            const lead = {
                                firstName: jsonData.givenName || jsonData.name?.split(' ')[0] || '',
                                lastName: jsonData.familyName || jsonData.name?.split(' ').slice(1).join(' ') || '',
                                email: jsonData.email || '',
                                phone: jsonData.telephone || '',
                                title: jsonData.jobTitle || jsonData.title || '',
                                organization: jsonData.worksFor?.name || jsonData.hiringOrganization?.name || '',
                                location: jsonData.address?.addressLocality || '',
                                linkedinUrl: jsonData.sameAs?.find((url) => url.includes('linkedin.com')) || '',
                                source: 'Toponehire.com',
                                rawData: jsonData
                            };

                            if (lead.firstName || lead.email) {
                                scrapedLeads.push(lead);
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing JSON-LD:', e);
                    }
                });
            }

            // If still no results, try a more generic approach
            if (scrapedLeads.length === 0) {
                // Look for any text patterns that might indicate contact information
                const pageText = $('body').text();
                
                // Try to find email patterns
                const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
                const emails = pageText.match(emailRegex) || [];
                
                // Try to find phone patterns
                const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
                const phones = pageText.match(phoneRegex) || [];

                // Create basic leads from found contact info
                emails.forEach((email, index) => {
                    if (scrapedLeads.length >= maxResults) return false;
                    
                    const emailParts = email.split('@');
                    const nameFromEmail = emailParts[0].replace(/[._-]/g, ' ');
                    const nameParts = nameFromEmail.split(/\s+/);
                    
                    scrapedLeads.push({
                        firstName: nameParts[0] || '',
                        lastName: nameParts.slice(1).join(' ') || '',
                        email: email,
                        phone: phones[index] || '',
                        title: '',
                        organization: emailParts[1]?.split('.')[0] || '',
                        location: '',
                        linkedinUrl: '',
                        source: 'Toponehire.com',
                        rawData: { extractedFrom: 'page-text' }
                    });
                });
            }

            console.log(`Successfully scraped ${scrapedLeads.length} leads from Toponehire.com`);

            res.status(200).json({
                success: true,
                message: `Successfully scraped ${scrapedLeads.length} leads`,
                leads: scrapedLeads,
                count: scrapedLeads.length,
                source: 'Toponehire.com',
                scrapedAt: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error scraping Toponehire.com:', error);
            
            // Provide helpful error messages
            let errorMessage = 'Failed to scrape data from Toponehire.com';
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                errorMessage = 'Connection timeout. Please check your internet connection and try again.';
            } else if (error.response) {
                errorMessage = `Server returned error: ${error.response.status} ${error.response.statusText}`;
            } else if (error.message) {
                errorMessage = error.message;
            }

            res.status(500).json({
                success: false,
                message: errorMessage,
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = ScrapeController;

