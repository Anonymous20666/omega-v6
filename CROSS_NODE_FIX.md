# Cross-Node Command Execution Fix

## Problem
When using `.updategstatus` (or any command) on one WhatsApp node, the other node was also responding to the same command. This caused duplicate command executions across all active nodes.

## Root Cause
The bot uses a global `eventBus` singleton that all nodes share. When Node A receives a message:
1. Node A emits `message.upsert` event to the eventBus
2. The CommandRouter (also a singleton) listens to this event
3. ALL nodes' command handlers pick up the event
4. Both Node A and Node B execute the same command

This happened because there was no isolation mechanism to ensure each node only processes its own messages.

## Solution
Added node isolation in the CommandRouter (`/root/omega-v5/core/commandRouter.js`):

```javascript
// Verify the message is actually from this socket's session
const sockBotId = sock.user?.id?.split(':')[0];
if (sockBotId && botId && sockBotId !== botId) {
    // This message is from a different node, ignore it
    return;
}
```

This check ensures:
- Each message's `botId` (the phone number that received it) matches the socket's `user.id`
- If they don't match, the message is from a different node and should be ignored
- Only the node that actually received the message will process it

## Technical Details

### Before Fix
```
User sends: .updategstatus
↓
Node A (2347086278942) receives message
↓
Node A emits to eventBus with botId=2347086278942
↓
CommandRouter processes event
↓
❌ BOTH Node A AND Node B execute the command
↓
Duplicate status updates sent
```

### After Fix
```
User sends: .updategstatus
↓
Node A (2347086278942) receives message
↓
Node A emits to eventBus with botId=2347086278942
↓
CommandRouter processes event
↓
Node A: sockBotId=2347086278942, botId=2347086278942 ✅ MATCH → Execute
Node B: sockBotId=2348164167112, botId=2347086278942 ❌ NO MATCH → Ignore
↓
Only Node A executes the command
```

## Files Modified
1. `/root/omega-v5/core/commandRouter.js` - Added botId verification for node isolation

## Testing
To verify the fix works:
1. Send `.updategstatus test` from Node A's WhatsApp
2. Only Node A should respond
3. Send `.updategstatus test` from Node B's WhatsApp
4. Only Node B should respond

## Impact
- ✅ Eliminates duplicate command executions
- ✅ Each node operates independently
- ✅ No performance impact (simple string comparison)
- ✅ Works for ALL commands, not just .updategstatus
- ✅ Maintains shared Intel database functionality

## Related Systems
This fix does NOT affect:
- Intel scraping (still shared across all nodes)
- Auto-join queue (still shared across all nodes)
- Menu generation (per-node as intended)
- Node mode settings (per-node as intended)

The shared eventBus is still used for:
- Intel link scraping (intentional - all nodes should see all links)
- System boot events
- Socket open events

But command execution is now properly isolated per node.
