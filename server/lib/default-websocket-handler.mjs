// Code for this lambda broken into several modules 
import { prepareAndCallLLM } from './prepare-and-call-llm.mjs';
import { savePrompt } from './database-helpers.mjs';
import { formatLLMMessage } from './llm-formatting-helpers.mjs';

import { makeApartmentSearchToolCalls } from './tools/apartment-search/tools.mjs';
import { makeRestaurantOrderingToolCalls } from './tools/restaurant-ordering/tools.mjs';
import { makeToolCallingExampleToolCalls } from './tools/tool-calling-example/tools.mjs';

import { FSDB } from "file-system-db"; 

/**
 * getSessionDetails
 */
const getSessionDetails = async (callSid) => {
    try {        
        const crSession = new FSDB(`../data/sessions/${callSid}/session.json`, false);
        const sessionDetails = crSession.get(callSid)
        if(!sessionDetails) {
            console.error("No session details found for callSid: ", callSid);
            return;
        }
        return sessionDetails;
    } catch (error) {
        console.error("Error getting call connection: ", error);
        throw error;
    }
};

/**
 * Main WebSocket Message Handler
 */
export const defaultWebsocketHandler = async (callSid, socket, body, toolCallCompletion, clientSocket) => { 

    let now = Date.now();
    let currentMessage = { ...body, "ts": now };

    try {
        if (body?.type === "info" && clientSocket !== null) {
            clientSocket.send(JSON.stringify(currentMessage));
        }        

        if (body?.type === "error") {
            console.error("Error event received from ConversationRelay server: ", body.description);
        }

        if (body?.type === "prompt" || body?.type === "dtmf") {                        

            console.info("Received prompt or dtmf => ", currentMessage);
            const sessionDetails = await getSessionDetails(callSid);
            
            if (clientSocket !== null) {
                clientSocket.send(JSON.stringify(currentMessage));
            }

            // The LLM is called here
            const llmResult = await prepareAndCallLLM({                
                callSid: callSid, 
                sessionDetails: sessionDetails, 
                socket: socket, 
                body: body, 
                toolCallCompletion: toolCallCompletion,
                clientSocket: clientSocket
            });                

            console.info("llmResult\n" + JSON.stringify(llmResult, null, 2));

            // --- CLEANING LOGIC ---
            // 1. Remove Markdown asterisks so the TTS doesn't say "Asterisk"
            // 2. Remove newlines so the voice flows naturally without weird gaps
            let cleanContent = "";
            if (llmResult.content) {
                cleanContent = llmResult.content
                    .replace(/\*\*/g, '')  // Removes bold markdown
                    .replace(/\*/g, '')    // Removes italic/bullet markdown
                    .replace(/\n/g, ' ')   // Replaces newlines with spaces
                    .trim();
            }

            // Format the CLEANED message for the database
            let newAssistantChatMessage = await formatLLMMessage("assistant", cleanContent);

            if (Object.keys(llmResult.tool_calls).length > 0 ) {
                newAssistantChatMessage.tool_calls = Object.values(llmResult.tool_calls);
            }
            
            console.info("newChatMessage before saving to database\n" + JSON.stringify(newAssistantChatMessage, null, 2));    

            await savePrompt(callSid, newAssistantChatMessage);            
            
            if (Object.keys(llmResult.tool_calls).length > 0 ) {
                let toolCallResult;
                switch (sessionDetails.useCase) {
                    case "restaurant-ordering":
                        toolCallResult = await makeRestaurantOrderingToolCalls(llmResult.tool_calls, callSid, sessionDetails);
                        break;
                    case "apartment-search":
                        toolCallResult = await makeApartmentSearchToolCalls(llmResult.tool_calls, callSid, sessionDetails);
                        break;
                    case "tool-calling-example":
                        toolCallResult = await makeToolCallingExampleToolCalls(llmResult.tool_calls, callSid, sessionDetails);
                        break;                        
                    default:
                        console.error("No tool calls handler found for use case: ", sessionDetails.useCase);
                        break;
                }

                if (toolCallResult) {
                    toolCallCompletion = true;
                    await prepareAndCallLLM({
                        callSid: callSid, 
                        sessionDetails: sessionDetails, 
                        socket: socket, 
                        body: null, 
                        toolCallCompletion: toolCallCompletion,
                        clientSocket: clientSocket
                    }); 
                }
            }

        } else if (body?.type === "interrupt") {
            console.info("Received interrupt event: ", currentMessage);
            if (clientSocket) clientSocket.send(JSON.stringify(currentMessage));
     
        } else if (body?.type === "setup") {
            console.info("Received setup event: ", currentMessage);            
            if (clientSocket) clientSocket.send(JSON.stringify(currentMessage));
            console.log("onConnectWebsocketHandler setup event called with callSid: ", callSid);

        } else if (body?.type === "end") {
            console.info("Received end event: ", currentMessage);
            if (clientSocket) clientSocket.send(JSON.stringify(currentMessage));
        }
    } catch (error) {
        console.log("defaultWebsocketHandler generated an error => ", error);
        throw new Error(error); 
    }
};