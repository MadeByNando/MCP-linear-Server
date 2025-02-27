require('dotenv').config();
const { MCPClient } = require('@modelcontextprotocol/sdk');

async function addIssue() {
    const client = new MCPClient({
        apiKey: process.env.MCP_API_KEY, // Ensure this is set in your .env file
        // other necessary configuration
    });

    try {
        const response = await client.createIssue({
            title: 'test',
            description: 'This is a test issue created via MCP',
            // other issue details like project ID, labels, etc.
        });

        console.log('Issue created successfully:', response);
    } catch (error) {
        console.error('Error creating issue:', error);
    }
}

addIssue(); 