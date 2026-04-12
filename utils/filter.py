import sys
import re
import yaml
import ast
from typing import Dict, Any, List

def parse_server_args_from_log(log_line: str) -> Dict[str, Any]:
    """
    Parse ServerArgs from a log line containing server_args=ServerArgs(...)
    """
    # Extract the ServerArgs content between the parentheses
    pattern = r"server_args=ServerArgs\((.*)\)$"
    match = re.search(pattern, log_line.strip(), re.DOTALL)
    
    if not match:
        return None
    
    args_content = match.group(1)
    
    # Parse the arguments
    args_dict = {}
    i = 0
    length = len(args_content)
    
    while i < length:
        # Skip whitespace
        while i < length and args_content[i].isspace():
            i += 1
        
        if i >= length:
            break
        
        # Find the key (until '=')
        key_start = i
        while i < length and args_content[i] != '=':
            i += 1
        
        if i >= length:
            break
            
        key = args_content[key_start:i].strip()
        i += 1  # Skip '='
        
        # Skip whitespace after '='
        while i < length and args_content[i].isspace():
            i += 1
        
        # Parse the value based on its type
        if i < length and args_content[i] == "'":
            # String value with single quotes
            i += 1
            value_start = i
            while i < length and args_content[i] != "'":
                i += 1
            value = args_content[value_start:i]
            i += 1  # Skip closing quote
        elif i < length and args_content[i] == '"':
            # String value with double quotes
            i += 1
            value_start = i
            while i < length and args_content[i] != '"':
                i += 1
            value = args_content[value_start:i]
            i += 1  # Skip closing quote
        elif i < length and args_content[i] == '[':
            # List value
            bracket_count = 1
            value_start = i
            i += 1
            while i < length and bracket_count > 0:
                if args_content[i] == '[':
                    bracket_count += 1
                elif args_content[i] == ']':
                    bracket_count -= 1
                i += 1
            value_str = args_content[value_start:i]
            try:
                value = ast.literal_eval(value_str)
            except:
                value = value_str
        elif i < length and args_content[i] == '{':
            # Dict value
            brace_count = 1
            value_start = i
            i += 1
            while i < length and brace_count > 0:
                if args_content[i] == '{':
                    brace_count += 1
                elif args_content[i] == '}':
                    brace_count -= 1
                i += 1
            value_str = args_content[value_start:i]
            try:
                value = ast.literal_eval(value_str)
            except:
                value = value_str
        elif i < length and args_content[i] == '(':
            # Tuple value
            paren_count = 1
            value_start = i
            i += 1
            while i < length and paren_count > 0:
                if args_content[i] == '(':
                    paren_count += 1
                elif args_content[i] == ')':
                    paren_count -= 1
                i += 1
            value_str = args_content[value_start:i]
            try:
                value = ast.literal_eval(value_str)
            except:
                value = value_str
        else:
            # Other values (numbers, booleans, None, etc.)
            value_start = i
            while i < length and args_content[i] not in [',', ' ']:
                i += 1
            value_str = args_content[value_start:i].strip()
            # Convert to appropriate Python type
            if value_str == 'True':
                value = True
            elif value_str == 'False':
                value = False
            elif value_str == 'None':
                value = None
            else:
                try:
                    # Try to convert to int or float
                    if '.' in value_str:
                        value = float(value_str)
                    else:
                        value = int(value_str)
                except ValueError:
                    # Keep as string
                    value = value_str
        
        args_dict[key] = value
        
        # Skip comma and whitespace
        while i < length and (args_content[i] == ',' or args_content[i].isspace()):
            i += 1
    
    return args_dict

def output_as_yaml(data_list: List[Dict[str, Any]], output_format: str = 'single'):
    """
    Output the parsed data as YAML
    
    Args:
        data_list: List of parsed ServerArgs dictionaries
        output_format: 'single' for single document, 'multi' for multi-document YAML
    """
    if output_format == 'multi':
        # Output as multi-document YAML (each document separated by '---')
        for i, data in enumerate(data_list):
            if i > 0:
                print('---')
            yaml.dump(
                data, 
                sys.stdout, 
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
                indent=2
            )
    else:
        # Output as a list or single document
        if len(data_list) == 1:
            yaml.dump(
                data_list[0], 
                sys.stdout, 
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
                indent=2
            )
        else:
            # Output as a list of configurations
            output = {'server_configs': data_list}
            yaml.dump(
                output, 
                sys.stdout, 
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
                indent=2
            )

def model_name_matches(config: Dict[str, Any], query: str) -> bool:
    """
    Return True if query is contained in a model-identifying field.
    """
    if not query:
        return True

    candidate_fields = [
        "model_path",
        "model",
        "served_model_name",
        "tokenizer_path",
    ]
    query_lower = query.lower()

    for field in candidate_fields:
        value = config.get(field)
        if value is None:
            continue
        if query_lower in str(value).lower():
            return True
    return False

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='Parse ServerArgs from sglang log and output as YAML')
    parser.add_argument('--format', choices=['single', 'multi', 'list'], default='list',
                        help='Output format: single (first only), multi (multi-document), list (wrapped in list)')
    parser.add_argument('--latest', action='store_true',
                        help='Only output the latest ServerArgs entry')
    parser.add_argument('--index', type=int, default=None,
                        help='Output specific ServerArgs entry by index (0-based)')
    parser.add_argument('--model-name-contains', type=str, default=None,
                        help='Only keep entries whose model name/path contains this text (case-insensitive), e.g. 397b')
    
    args = parser.parse_args()
    
    # Read from stdin and collect all ServerArgs
    server_args_list = []
    line_number = 0
    
    for line in sys.stdin:
        line_number += 1
        if 'server_args=ServerArgs' in line:
            try:
                args_dict = parse_server_args_from_log(line)
                if args_dict:
                    # Add metadata about where this was found
                    args_dict['_metadata'] = {
                        'line_number': line_number,
                        'timestamp': line[:19] if line.startswith('[') else None
                    }
                    server_args_list.append(args_dict)
            except Exception as e:
                print(f"Error parsing ServerArgs at line {line_number}: {e}", file=sys.stderr)
    
    if not server_args_list:
        print("No ServerArgs found in input", file=sys.stderr)
        sys.exit(1)

    # Filter by model name/path if requested
    if args.model_name_contains:
        server_args_list = [
            config for config in server_args_list
            if model_name_matches(config, args.model_name_contains)
        ]
        if not server_args_list:
            print(
                f"No ServerArgs matched model filter: {args.model_name_contains}",
                file=sys.stderr
            )
            sys.exit(1)
    
    # Handle different output options
    if args.index is not None:
        if 0 <= args.index < len(server_args_list):
            server_args_list = [server_args_list[args.index]]
        else:
            print(f"Index {args.index} out of range (0-{len(server_args_list)-1})", file=sys.stderr)
            sys.exit(1)
    elif args.latest:
        server_args_list = [server_args_list[-1]]
    
    # Output as YAML
    if args.format == 'single' and len(server_args_list) > 1:
        print(f"Warning: Found {len(server_args_list)} ServerArgs entries, but 'single' format requested. Only showing the first one.", file=sys.stderr)
        server_args_list = [server_args_list[0]]
    
    # Remove metadata if not needed (optional)
    show_metadata = False  # Set to True if you want to see line numbers
    if not show_metadata:
        for config in server_args_list:
            config.pop('_metadata', None)
    
    output_as_yaml(server_args_list, args.format if args.format != 'list' else 'single')

if __name__ == "__main__":
    main()