/**
 * Developer Level Dashboard
 * Analyzes GitHub activity to determine developer maturity levels (M1-M4)
 * Based on the Situational Leadership Model
 */

class GitHubAnalyzer {
    constructor(owner, repo, token = null, days = 90) {
        this.owner = owner;
        this.repo = repo;
        this.token = token;
        this.days = days;
        this.baseUrl = 'https://api.github.com';
        this.sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        this.developers = new Map();
        this.rateLimitRemaining = null;
        this.rateLimitReset = null;
    }

    getHeaders() {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
        };
        if (this.token) {
            headers['Authorization'] = `token ${this.token}`;
        }
        return headers;
    }

    updateRateLimitInfo(response) {
        this.rateLimitRemaining = parseInt(response.headers.get('X-RateLimit-Remaining')) || null;
        this.rateLimitReset = parseInt(response.headers.get('X-RateLimit-Reset')) || null;

        if (this.rateLimitRemaining !== null && this.rateLimitRemaining < 10) {
            const resetTime = this.rateLimitReset ? new Date(this.rateLimitReset * 1000).toLocaleTimeString() : 'unknown';
            this.updateStatus(`Warning: Only ${this.rateLimitRemaining} API calls remaining. Resets at ${resetTime}`);
        }
    }

    async fetchPaginated(endpoint, params = {}) {
        const results = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const url = new URL(`${this.baseUrl}${endpoint}`);
            url.searchParams.set('per_page', perPage);
            url.searchParams.set('page', page);

            for (const [key, value] of Object.entries(params)) {
                url.searchParams.set(key, value);
            }

            try {
                const response = await fetch(url, { headers: this.getHeaders() });
                this.updateRateLimitInfo(response);

                if (!response.ok) {
                    if (response.status === 403) {
                        const resetTime = this.rateLimitReset ? new Date(this.rateLimitReset * 1000).toLocaleTimeString() : 'unknown';
                        console.warn(`Rate limit exceeded. Resets at ${resetTime}`);
                        this.updateStatus(`Rate limit hit! Resets at ${resetTime}. Add a GitHub token for higher limits.`);
                        break;
                    }
                    if (response.status === 404) {
                        throw new Error(`Repository not found: ${this.owner}/${this.repo}`);
                    }
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();

                if (data.length === 0) break;

                results.push(...data);

                if (data.length < perPage) break;

                page++;

                // Limit pages to avoid excessive API calls
                if (page > 5) break;

            } catch (error) {
                console.error(`Error fetching ${endpoint}:`, error);
                throw error;
            }
        }

        return results;
    }

    updateStatus(message) {
        const statusEl = document.getElementById('loading-status');
        if (statusEl) {
            statusEl.textContent = message;
        }
    }

    getDeveloper(login, avatarUrl = '') {
        if (!this.developers.has(login)) {
            this.developers.set(login, {
                login,
                avatarUrl,
                commits: 0,
                prsCreated: 0,
                prsMerged: 0,
                prsReviewed: 0,
                reviewComments: 0,
                issuesCreated: 0,
                issuesClosed: 0,
                issueComments: 0,
                linesAdded: 0,
                linesDeleted: 0,
                filesChanged: 0,
                activeDays: new Set(),
                tasks: [],
                firstActivity: null,
                lastActivity: null
            });
        }
        return this.developers.get(login);
    }

    updateActivityDate(dev, date) {
        const d = new Date(date);
        const dayKey = d.toISOString().split('T')[0];
        dev.activeDays.add(dayKey);

        if (!dev.firstActivity || d < new Date(dev.firstActivity)) {
            dev.firstActivity = date;
        }
        if (!dev.lastActivity || d > new Date(dev.lastActivity)) {
            dev.lastActivity = date;
        }
    }

    async fetchCommits() {
        this.updateStatus('Fetching commits...');
        const commits = await this.fetchPaginated(`/repos/${this.owner}/${this.repo}/commits`, {
            since: this.sinceDate
        });

        for (const commit of commits) {
            if (commit.author && commit.author.login) {
                const dev = this.getDeveloper(commit.author.login, commit.author.avatar_url);
                dev.commits++;
                this.updateActivityDate(dev, commit.commit.author.date);

                // Fetch commit details for lines changed (limited to first 50)
                if (commits.indexOf(commit) < 50) {
                    try {
                        const response = await fetch(
                            `${this.baseUrl}/repos/${this.owner}/${this.repo}/commits/${commit.sha}`,
                            { headers: this.getHeaders() }
                        );
                        if (response.ok) {
                            const details = await response.json();
                            if (details.stats) {
                                dev.linesAdded += details.stats.additions || 0;
                                dev.linesDeleted += details.stats.deletions || 0;
                            }
                            if (details.files) {
                                dev.filesChanged += details.files.length;
                            }
                        }
                    } catch (e) {
                        // Skip on error
                    }
                }
            }
        }

        return commits.length;
    }

    async fetchPullRequests() {
        this.updateStatus('Fetching pull requests...');
        const prs = await this.fetchPaginated(`/repos/${this.owner}/${this.repo}/pulls`, {
            state: 'all',
            sort: 'updated',
            direction: 'desc'
        });

        const recentPRs = prs.filter(pr => new Date(pr.created_at) >= new Date(this.sinceDate));

        for (const pr of recentPRs) {
            if (pr.user && pr.user.login) {
                const dev = this.getDeveloper(pr.user.login, pr.user.avatar_url);
                dev.prsCreated++;

                if (pr.merged_at) {
                    dev.prsMerged++;
                }

                this.updateActivityDate(dev, pr.created_at);

                dev.tasks.push({
                    type: 'pr',
                    title: pr.title,
                    number: pr.number,
                    state: pr.state,
                    merged: !!pr.merged_at
                });
            }
        }

        return recentPRs.length;
    }

    async fetchReviews() {
        this.updateStatus('Fetching PR reviews...');

        // Use the pulls endpoint we already have data from, limit API calls
        const prs = await this.fetchPaginated(`/repos/${this.owner}/${this.repo}/pulls`, {
            state: 'all',
            sort: 'updated',
            direction: 'desc'
        });

        const recentPRs = prs.filter(pr => new Date(pr.updated_at) >= new Date(this.sinceDate));

        // Limit to 20 PRs to save API calls
        const prsToCheck = recentPRs.slice(0, 20);
        this.updateStatus(`Fetching reviews for ${prsToCheck.length} recent PRs...`);

        for (let i = 0; i < prsToCheck.length; i++) {
            const pr = prsToCheck[i];
            this.updateStatus(`Fetching reviews (${i + 1}/${prsToCheck.length})...`);

            // Check rate limit before each call
            if (this.rateLimitRemaining !== null && this.rateLimitRemaining < 5) {
                this.updateStatus('Stopping review fetch to preserve rate limit...');
                break;
            }

            try {
                const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${pr.number}/reviews`;
                const response = await fetch(url, { headers: this.getHeaders() });
                this.updateRateLimitInfo(response);

                if (!response.ok) continue;

                const reviews = await response.json();

                for (const review of reviews) {
                    if (review.user && review.user.login &&
                        new Date(review.submitted_at) >= new Date(this.sinceDate)) {
                        const dev = this.getDeveloper(review.user.login, review.user.avatar_url);
                        dev.prsReviewed++;
                        this.updateActivityDate(dev, review.submitted_at);

                        dev.tasks.push({
                            type: 'review',
                            title: `Review on PR #${pr.number}: ${pr.title}`,
                            number: pr.number,
                            state: review.state
                        });
                    }
                }
            } catch (e) {
                console.warn(`Error fetching reviews for PR #${pr.number}:`, e);
            }
        }

        // Fetch review comments in bulk (more efficient)
        this.updateStatus('Fetching review comments...');
        try {
            const comments = await this.fetchPaginated(
                `/repos/${this.owner}/${this.repo}/pulls/comments`,
                { since: this.sinceDate, sort: 'updated', direction: 'desc' }
            );

            for (const comment of comments) {
                if (comment.user && comment.user.login) {
                    const dev = this.getDeveloper(comment.user.login, comment.user.avatar_url);
                    dev.reviewComments++;
                    this.updateActivityDate(dev, comment.created_at);
                }
            }
        } catch (e) {
            console.warn('Error fetching review comments:', e);
        }
    }

    async fetchIssues() {
        this.updateStatus('Fetching issues...');
        const issues = await this.fetchPaginated(`/repos/${this.owner}/${this.repo}/issues`, {
            state: 'all',
            since: this.sinceDate,
            sort: 'updated',
            direction: 'desc'
        });

        // Filter out PRs (they come in the issues endpoint too)
        const realIssues = issues.filter(issue => !issue.pull_request);

        for (const issue of realIssues) {
            if (issue.user && issue.user.login) {
                const dev = this.getDeveloper(issue.user.login, issue.user.avatar_url);
                dev.issuesCreated++;

                if (issue.state === 'closed') {
                    dev.issuesClosed++;
                }

                this.updateActivityDate(dev, issue.created_at);

                dev.tasks.push({
                    type: 'issue',
                    title: issue.title,
                    number: issue.number,
                    state: issue.state
                });
            }
        }

        return realIssues.length;
    }

    async fetchIssueComments() {
        this.updateStatus('Fetching issue comments...');
        const comments = await this.fetchPaginated(
            `/repos/${this.owner}/${this.repo}/issues/comments`,
            { since: this.sinceDate, sort: 'updated', direction: 'desc' }
        );

        for (const comment of comments) {
            if (comment.user && comment.user.login) {
                const dev = this.getDeveloper(comment.user.login, comment.user.avatar_url);
                dev.issueComments++;
                this.updateActivityDate(dev, comment.created_at);
            }
        }

        return comments.length;
    }

    calculateMetrics() {
        this.updateStatus('Calculating developer metrics...');

        const results = [];

        for (const [login, dev] of this.developers) {
            // Skip bots
            if (login.includes('[bot]') || login.endsWith('-bot')) {
                continue;
            }

            // Skip developers with no PR activity (neither created nor reviewed)
            if (dev.prsCreated === 0 && dev.prsReviewed === 0) {
                continue;
            }

            // Calculate Ability Score (based on code output and quality indicators)
            const abilityFactors = {
                commits: Math.min(dev.commits / 30, 1) * 20,           // Up to 20 points
                prsCreated: Math.min(dev.prsCreated / 10, 1) * 15,    // Up to 15 points
                prsMerged: Math.min(dev.prsMerged / 8, 1) * 20,       // Up to 20 points
                codeVolume: Math.min((dev.linesAdded + dev.linesDeleted) / 5000, 1) * 15, // Up to 15 points
                filesChanged: Math.min(dev.filesChanged / 100, 1) * 10, // Up to 10 points
                reviewsGiven: Math.min(dev.prsReviewed / 10, 1) * 20   // Up to 20 points (shows expertise)
            };

            const abilityScore = Object.values(abilityFactors).reduce((a, b) => a + b, 0);

            // Calculate Engagement Score (based on consistency and participation)
            const totalDays = this.days;
            const activeDaysCount = dev.activeDays.size;
            const consistencyRatio = activeDaysCount / Math.min(totalDays, 90);

            const engagementFactors = {
                consistency: consistencyRatio * 30,                     // Up to 30 points
                issueComments: Math.min(dev.issueComments / 20, 1) * 15, // Up to 15 points
                reviewComments: Math.min(dev.reviewComments / 15, 1) * 20, // Up to 20 points
                issuesCreated: Math.min(dev.issuesCreated / 5, 1) * 10,  // Up to 10 points
                prsReviewed: Math.min(dev.prsReviewed / 10, 1) * 15,    // Up to 15 points
                recency: this.calculateRecency(dev.lastActivity) * 10   // Up to 10 points
            };

            const engagementScore = Object.values(engagementFactors).reduce((a, b) => a + b, 0);

            // Normalize scores to 1-3 scale
            const abilityLevel = this.normalizeToLevel(abilityScore);
            const engagementLevel = this.normalizeToLevel(engagementScore);

            // Determine M-level based on matrix
            const mLevel = this.calculateMLevel(abilityLevel, engagementLevel);

            results.push({
                login: dev.login,
                avatarUrl: dev.avatarUrl,
                abilityScore: Math.round(abilityScore),
                engagementScore: Math.round(engagementScore),
                abilityLevel,
                engagementLevel,
                mLevel,
                metrics: {
                    commits: dev.commits,
                    prsCreated: dev.prsCreated,
                    prsMerged: dev.prsMerged,
                    prsReviewed: dev.prsReviewed,
                    reviewComments: dev.reviewComments,
                    issuesCreated: dev.issuesCreated,
                    issueComments: dev.issueComments,
                    activeDays: activeDaysCount,
                    linesAdded: dev.linesAdded,
                    linesDeleted: dev.linesDeleted
                },
                tasks: dev.tasks.slice(0, 5) // Top 5 tasks
            });
        }

        // Sort by M-level (descending) then by ability score
        results.sort((a, b) => {
            const levelOrder = { 'M4': 4, 'M3': 3, 'M2': 2, 'M1': 1 };
            if (levelOrder[b.mLevel] !== levelOrder[a.mLevel]) {
                return levelOrder[b.mLevel] - levelOrder[a.mLevel];
            }
            return b.abilityScore - a.abilityScore;
        });

        return results;
    }

    calculateRecency(lastActivity) {
        if (!lastActivity) return 0;
        const daysSinceLast = (Date.now() - new Date(lastActivity)) / (1000 * 60 * 60 * 24);
        if (daysSinceLast <= 7) return 1;
        if (daysSinceLast <= 14) return 0.8;
        if (daysSinceLast <= 30) return 0.5;
        if (daysSinceLast <= 60) return 0.3;
        return 0.1;
    }

    normalizeToLevel(score) {
        // Convert 0-100 score to 1-3 level
        if (score >= 60) return 3; // High
        if (score >= 30) return 2; // Medium
        return 1; // Low
    }

    calculateMLevel(ability, engagement) {
        /**
         * Matrix mapping:
         * High ability (3):
         *   - Low/Medium engagement (1-2) = M3
         *   - High engagement (3) = M4
         * Medium ability (2):
         *   - Low engagement (1) = M1
         *   - Medium/High engagement (2-3) = M2
         * Low ability (1):
         *   - Low engagement (1) = M1
         *   - Medium/High engagement (2-3) = M2
         */

        if (ability === 3) {
            return engagement === 3 ? 'M4' : 'M3';
        } else {
            return engagement === 1 ? 'M1' : 'M2';
        }
    }

    async analyze() {
        this.updateStatus('Starting analysis...');

        // Check rate limit first
        try {
            const response = await fetch(`${this.baseUrl}/rate_limit`, { headers: this.getHeaders() });
            if (response.ok) {
                const data = await response.json();
                const remaining = data.rate.remaining;
                const limit = data.rate.limit;
                this.rateLimitRemaining = remaining;
                this.updateStatus(`API rate limit: ${remaining}/${limit} remaining`);

                if (remaining < 20) {
                    throw new Error(`Low API rate limit (${remaining} remaining). Please add a GitHub token or wait.`);
                }
            }
        } catch (e) {
            if (e.message.includes('Low API')) throw e;
            console.warn('Could not check rate limit:', e);
        }

        let commitCount = 0, prCount = 0, issueCount = 0;

        try {
            commitCount = await this.fetchCommits();
            this.updateStatus(`Found ${commitCount} commits, ${this.developers.size} developers so far...`);
        } catch (e) {
            console.error('Error fetching commits:', e);
        }

        try {
            prCount = await this.fetchPullRequests();
            this.updateStatus(`Found ${prCount} PRs, ${this.developers.size} developers so far...`);
        } catch (e) {
            console.error('Error fetching PRs:', e);
        }

        try {
            await this.fetchReviews();
        } catch (e) {
            console.error('Error fetching reviews:', e);
        }

        try {
            issueCount = await this.fetchIssues();
            this.updateStatus(`Found ${issueCount} issues, ${this.developers.size} developers so far...`);
        } catch (e) {
            console.error('Error fetching issues:', e);
        }

        try {
            await this.fetchIssueComments();
        } catch (e) {
            console.error('Error fetching comments:', e);
        }

        this.updateStatus(`Analyzing ${this.developers.size} developers...`);

        const results = this.calculateMetrics();

        if (results.length === 0 && this.developers.size === 0) {
            throw new Error(`No activity found. Checked: ${commitCount} commits, ${prCount} PRs, ${issueCount} issues in last ${this.days} days.`);
        }

        return results;
    }
}

class Dashboard {
    constructor() {
        this.form = document.getElementById('repo-form');
        this.loadingSection = document.getElementById('loading');
        this.resultsSection = document.getElementById('results');
        this.analyzeBtn = document.getElementById('analyze-btn');
        this.currentDevelopers = [];
        this.currentRepoInfo = { owner: '', repo: '' };

        this.bindEvents();
    }

    bindEvents() {
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.analyze();
        });

        // Export buttons
        document.getElementById('export-pdf-btn')?.addEventListener('click', () => {
            this.exportPDF();
        });

        document.getElementById('export-csv-btn')?.addEventListener('click', () => {
            this.exportCSV();
        });
    }

    exportPDF() {
        // Use browser print functionality with print styles
        const title = document.title;
        document.title = `Developer Level Report - ${this.currentRepoInfo.owner}/${this.currentRepoInfo.repo}`;
        window.print();
        document.title = title;
    }

    exportCSV() {
        if (this.currentDevelopers.length === 0) {
            alert('No data to export');
            return;
        }

        const headers = [
            'Developer',
            'Development Level',
            'Ability Score',
            'Ability Level',
            'Engagement Score',
            'Engagement Level',
            'Commits',
            'PRs Created',
            'PRs Merged',
            'PRs Reviewed',
            'Review Comments',
            'Issues Created',
            'Issue Comments',
            'Active Days',
            'Lines Added',
            'Lines Deleted'
        ];

        const rows = this.currentDevelopers.map(dev => [
            dev.login,
            dev.mLevel,
            dev.abilityScore,
            this.getLevelLabel(dev.abilityLevel),
            dev.engagementScore,
            this.getLevelLabel(dev.engagementLevel),
            dev.metrics.commits,
            dev.metrics.prsCreated,
            dev.metrics.prsMerged,
            dev.metrics.prsReviewed,
            dev.metrics.reviewComments,
            dev.metrics.issuesCreated,
            dev.metrics.issueComments,
            dev.metrics.activeDays,
            dev.metrics.linesAdded,
            dev.metrics.linesDeleted
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `developer-levels-${this.currentRepoInfo.owner}-${this.currentRepoInfo.repo}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    showLoading() {
        this.loadingSection.classList.remove('hidden');
        this.resultsSection.classList.add('hidden');
        this.analyzeBtn.disabled = true;
        this.analyzeBtn.textContent = 'Analyzing...';
    }

    hideLoading() {
        this.loadingSection.classList.add('hidden');
        this.analyzeBtn.disabled = false;
        this.analyzeBtn.textContent = 'Analyze Repository';
    }

    showResults() {
        this.resultsSection.classList.remove('hidden');
    }

    async analyze() {
        const owner = document.getElementById('owner').value.trim();
        const repo = document.getElementById('repo').value.trim();
        const token = document.getElementById('token').value.trim();
        const days = parseInt(document.getElementById('days').value) || 90;

        if (!owner || !repo) {
            alert('Please enter repository owner and name');
            return;
        }

        this.showLoading();

        try {
            const analyzer = new GitHubAnalyzer(owner, repo, token || null, days);
            const results = await analyzer.analyze();

            if (results.length === 0) {
                const msg = `No developer activity found for ${owner}/${repo} in the last ${days} days.\n\n` +
                    'Possible reasons:\n' +
                    '- Repository has no recent commits/PRs/issues\n' +
                    '- Repository is private (add GitHub token)\n' +
                    '- Try a longer time period\n' +
                    '- Try a more active repository like "facebook/react"';
                alert(msg);
                this.hideLoading();
                return;
            }

            this.currentDevelopers = results;
            this.currentRepoInfo = { owner, repo };
            this.renderResults(results);
            this.showResults();
        } catch (error) {
            console.error('Analysis error:', error);
            let msg = error.message;
            if (msg.includes('404')) {
                msg = `Repository "${owner}/${repo}" not found. Check the owner and repo name.`;
            } else if (msg.includes('rate limit') || msg.includes('403')) {
                msg = 'GitHub API rate limit exceeded.\n\nSolutions:\n' +
                    '1. Add a GitHub Personal Access Token (Settings > Developer settings > Personal access tokens)\n' +
                    '2. Wait for rate limit to reset\n\n' +
                    'Without token: 60 requests/hour\n' +
                    'With token: 5000 requests/hour';
            }
            alert(`Error: ${msg}`);
        } finally {
            this.hideLoading();
        }
    }

    renderResults(developers) {
        this.renderMatrix(developers);
        this.renderTable(developers);
        this.renderActivityCards(developers);
    }

    renderMatrix(developers) {
        // Clear all matrix cells
        const cells = [
            'm3-high-low', 'm3-high-med', 'm4-high-high',
            'm1-med-low', 'm2-med-med', 'm2-med-high',
            'm1-low-low', 'm2-low-med', 'm2-low-high'
        ];

        cells.forEach(cellId => {
            const cell = document.getElementById(cellId);
            if (cell) cell.innerHTML = '';
        });

        // Place developers in matrix
        for (const dev of developers) {
            const cellId = this.getMatrixCellId(dev.abilityLevel, dev.engagementLevel);
            const cell = document.getElementById(cellId);

            if (cell) {
                const badge = document.createElement('span');
                badge.className = 'dev-badge';
                badge.textContent = dev.login.substring(0, 10);
                badge.title = `${dev.login}\nAbility: ${dev.abilityScore}/100\nEngagement: ${dev.engagementScore}/100`;
                cell.appendChild(badge);
            }
        }
    }

    getMatrixCellId(ability, engagement) {
        const abilityMap = { 3: 'high', 2: 'med', 1: 'low' };
        const engagementMap = { 3: 'high', 2: 'med', 1: 'low' };

        const abilityStr = abilityMap[ability];
        const engagementStr = engagementMap[engagement];

        // Map to M-level
        let mLevel;
        if (ability === 3) {
            mLevel = engagement === 3 ? 'm4' : 'm3';
        } else {
            mLevel = engagement === 1 ? 'm1' : 'm2';
        }

        return `${mLevel}-${abilityStr}-${engagementStr}`;
    }

    renderTable(developers) {
        const tbody = document.getElementById('developers-tbody');
        tbody.innerHTML = '';

        for (const dev of developers) {
            const row = document.createElement('tr');

            row.innerHTML = `
                <td>
                    <img src="${dev.avatarUrl}" alt="${dev.login}" class="developer-avatar">
                    <a href="https://github.com/${dev.login}" target="_blank" class="developer-link">${dev.login}</a>
                </td>
                <td>
                    <ul class="task-list">
                        ${dev.tasks.map(task => `
                            <li>
                                <span class="task-type ${task.type}">${task.type.toUpperCase()}</span>
                                #${task.number}: ${this.truncate(task.title, 40)}
                            </li>
                        `).join('')}
                        ${dev.tasks.length === 0 ? '<li>No recent tasks</li>' : ''}
                    </ul>
                </td>
                <td>
                    <div class="skill-bar">
                        <div class="skill-fill" style="width: ${dev.abilityScore}%"></div>
                        <span class="bar-label">${this.getLevelLabel(dev.abilityLevel)} (${dev.abilityScore})</span>
                    </div>
                </td>
                <td>
                    <div class="engagement-bar">
                        <div class="engagement-fill" style="width: ${dev.engagementScore}%"></div>
                        <span class="bar-label">${this.getLevelLabel(dev.engagementLevel)} (${dev.engagementScore})</span>
                    </div>
                </td>
                <td>
                    <span class="level-badge ${dev.mLevel.toLowerCase()}">${dev.mLevel}</span>
                </td>
                <td>
                    <ul class="metrics-list">
                        <li>Commits: ${dev.metrics.commits}</li>
                        <li>PRs: ${dev.metrics.prsCreated} (${dev.metrics.prsMerged} merged)</li>
                        <li>Reviews: ${dev.metrics.prsReviewed}</li>
                        <li>Active days: ${dev.metrics.activeDays}</li>
                    </ul>
                </td>
            `;

            tbody.appendChild(row);
        }
    }

    renderActivityCards(developers) {
        const container = document.getElementById('activity-cards');
        container.innerHTML = '';

        // Show top 10 developers
        for (const dev of developers.slice(0, 10)) {
            const card = document.createElement('div');
            card.className = 'activity-card';
            card.style.borderLeftColor = this.getLevelColor(dev.mLevel);

            card.innerHTML = `
                <h3>
                    <img src="${dev.avatarUrl}" alt="${dev.login}" class="avatar">
                    <a href="https://github.com/${dev.login}" target="_blank">${dev.login}</a>
                    <span class="level-badge ${dev.mLevel.toLowerCase()}">${dev.mLevel}</span>
                </h3>
                <div class="activity-stats">
                    <div class="stat-item">
                        <div class="stat-value">${dev.metrics.commits}</div>
                        <div class="stat-label">Commits</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${dev.metrics.prsCreated}</div>
                        <div class="stat-label">PRs Created</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${dev.metrics.prsReviewed}</div>
                        <div class="stat-label">Reviews</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${dev.metrics.activeDays}</div>
                        <div class="stat-label">Active Days</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${dev.metrics.issueComments + dev.metrics.reviewComments}</div>
                        <div class="stat-label">Comments</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${this.formatNumber(dev.metrics.linesAdded + dev.metrics.linesDeleted)}</div>
                        <div class="stat-label">Lines Changed</div>
                    </div>
                </div>
            `;

            container.appendChild(card);
        }
    }

    getLevelLabel(level) {
        const labels = { 1: 'Low', 2: 'Medium', 3: 'High' };
        return labels[level] || 'Unknown';
    }

    getLevelColor(mLevel) {
        const colors = {
            'M1': '#f0b429',
            'M2': '#f97316',
            'M3': '#22d3ee',
            'M4': '#2563eb'
        };
        return colors[mLevel] || '#999';
    }

    truncate(str, length) {
        if (str.length <= length) return str;
        return str.substring(0, length) + '...';
    }

    formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }
}

// Initialize dashboard on page load
document.addEventListener('DOMContentLoaded', () => {
    new Dashboard();
});
