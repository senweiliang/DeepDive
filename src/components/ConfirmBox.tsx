import { Box, Text } from "ink";

interface Props {
  toolName: string;
  args: Record<string, unknown>;
}

export function ConfirmBox({ toolName, args }: Props) {
  const summary = summarizeArgs(toolName, args);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Text color="yellow" bold>
        Approve tool execution?
      </Text>
      <Text>
        <Text bold>{toolName}</Text> {summary}
      </Text>
      <Box marginTop={1}>
        <Text color="green">[Y] Approve</Text>
        <Text>  </Text>
        <Text color="red">[N] Deny</Text>
      </Box>
    </Box>
  );
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return String(args.command || "");
    case "read_file":
    case "write_file":
    case "edit_file":
      return String(args.path || "");
    case "glob":
    case "grep":
      return String(args.pattern || "");
    default:
      return JSON.stringify(args);
  }
}
