require('dotenv').config();
const express = require('express');
const { Octokit } = require('@octokit/rest');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    message: 'LLM Deployment API is active',
    timestamp: new Date().toISOString()
  });
});

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const MIT_LICENSE = `MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

async function generateCode(brief, checks, attachments) {
  const attachmentText = attachments.map(a => 
    `Attachment: ${a.name} - ${a.url.substring(0, 100)}...`
  ).join('\n');

  const prompt = `Create a complete, self-contained HTML file that does this:

${brief}

Requirements:
${checks.map(c => `- ${c}`).join('\n')}

${attachments.length > 0 ? `\nAttachments provided:\n${attachmentText}` : ''}

Return ONLY valid HTML code with inline CSS and JavaScript. Make it functional and complete.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000
      }),
      timeout: 30000 // 30 second timeout
    });

    const data = await response.json();
    
    console.log('API Response Status:', response.status);
    
    if (data.error) {
      throw new Error(`Groq API Error: ${data.error.message}`);
    }
    
    if (!data.choices || !data.choices[0]) {
      throw new Error(`Unexpected API response format: ${JSON.stringify(data)}`);
    }
    
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Full error in generateCode:', error);
    throw error;
  }
}

async function createGitHubRepo(repoName, code, brief, checks) {
  const owner = process.env.GITHUB_USERNAME;
  
  try {
    const repo = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      description: brief.substring(0, 100),
      auto_init: false,
      private: false
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const readme = `# ${repoName}

## Summary
${brief}

## Setup
1. Clone this repository
2. Open index.html in a browser

## Usage
Visit the GitHub Pages URL or open index.html locally.

## Code Explanation
This application is built as a single HTML file with embedded CSS and JavaScript to meet the following requirements:
${checks.map(c => `- ${c}`).join('\n')}

## License
MIT License`;

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: 'README.md',
      message: 'Add README',
      content: Buffer.from(readme).toString('base64')
    });

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: 'LICENSE',
      message: 'Add MIT license',
      content: Buffer.from(MIT_LICENSE).toString('base64')
    });

    const fileResponse = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: 'index.html',
      message: 'Add application code',
      content: Buffer.from(code).toString('base64')
    });

    try {
      await octokit.repos.createPagesSite({
        owner,
        repo: repoName,
        source: { branch: 'main', path: '/' }
      });
    } catch (error) {
      console.log('Pages setup may need manual enabling:', error.message);
    }

    return {
      repo_url: repo.data.html_url,
      commit_sha: fileResponse.data.commit.sha,
      pages_url: `https://${owner}.github.io/${repoName}/`
    };
  } catch (error) {
    console.error('Error creating GitHub repo:', error);
    throw error;
  }
}

async function notifyEvaluator(evaluationUrl, payload, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(evaluationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000 // 10 second timeout
      });

      if (response.ok) {
        console.log('✅ Evaluator notified successfully');
        return true;
      }
      
      console.log(`Evaluator response status: ${response.status}`);
    } catch (error) {
      console.log(`Notify attempt ${i + 1} failed:`, error.message);
    }

    if (i < retries - 1) {
      const delay = Math.pow(2, i) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  console.error('❌ Failed to notify evaluator after all retries');
  return false;
}

// CRITICAL FIX: Process and respond synchronously
app.post('/build', async (req, res) => {
  const startTime = Date.now();
  console.log('📬 Received build request');

  try {
    // Validate secret
    if (req.body.secret !== process.env.MY_SECRET) {
      console.log('❌ Invalid secret');
      return res.status(403).json({ error: 'Invalid secret' });
    }

    const { email, task, round, nonce, brief, checks, evaluation_url, attachments = [] } = req.body;

    console.log(`Building app for task: ${task}, round: ${round}`);

    // Validate required fields
    if (!email || !task || !round || !brief || !checks || !evaluation_url) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate code
    console.log('🤖 Generating code...');
    const code = await generateCode(brief, checks, attachments);
    console.log('✅ Code generated');

    // Create GitHub repo
    console.log('📦 Creating GitHub repository...');
    const uniqueId = nonce || Date.now();
    const repoName = `${task}-r${round}-${uniqueId}`;
    const repoInfo = await createGitHubRepo(repoName, code, brief, checks);
    console.log('✅ Repository created:', repoInfo.repo_url);

    // Prepare response payload
    const responsePayload = {
      email,
      task,
      round,
      nonce,
      repo_url: repoInfo.repo_url,
      commit_sha: repoInfo.commit_sha,
      pages_url: repoInfo.pages_url
    };

    // Notify evaluator (async, but we'll wait a bit)
    console.log('📤 Notifying evaluator...');
    notifyEvaluator(evaluation_url, responsePayload).catch(err => 
      console.error('Error notifying evaluator:', err)
    );

    const elapsedTime = Date.now() - startTime;
    console.log(`✅ Request completed in ${elapsedTime}ms`);

    // Send success response to the evaluator
    return res.status(200).json({
      message: 'Build completed successfully',
      ...responsePayload,
      processing_time: elapsedTime
    });

  } catch (error) {
    const elapsedTime = Date.now() - startTime;
    console.error('❌ Error processing build:', error);
    console.error('Stack trace:', error.stack);
    
    return res.status(500).json({
      error: 'Build failed',
      message: error.message,
      processing_time: elapsedTime
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// CRITICAL FIX: Bind to 0.0.0.0 for Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`GitHub Username: ${process.env.GITHUB_USERNAME || 'NOT SET'}`);
});
